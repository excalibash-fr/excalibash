package main

import (
	"context"
	"encoding/json"
	"net"
	"net/netip"
	"os/exec"
	"regexp"
	"runtime"
	"strconv"
	"sync"
	"time"
)

// Reachability probes for the cables of a diagram: the machine's owner asks "can this machine
// reach these addresses?". The request is boxed under the machine auth key (shared only with
// the owner), so the server can neither read the addresses nor make the agent probe anything.
// Each address is checked with the system's ping, given as a plain argument (never a shell).
// A request with kind "ifaces" instead asks for the machine's network interfaces and addresses
// (net.Interfaces, no command run), to compare them with the diagram.

const (
	maxProbeTargets = 32
	probeParallel   = 8
	probeTimeout    = 3 * time.Second
	// Caps of the "ifaces" answer: a machine with more is truncated, never refused.
	maxProbeIfaces = 256
	maxIfaceAddrs  = 64
)

type probeHub struct {
	auth   []byte
	nonces *nonceSet // request ids seen recently, against replays
}

func newProbeHub(auth []byte) *probeHub {
	return &probeHub{auth: auth, nonces: newNonceSet(maxProbeNonces)}
}

type probeResult struct {
	Up bool    `json:"up"`
	Ms float64 `json:"ms,omitempty"`
}

// handle answers one probe request: box(auth, {targets}, "eb:probe:<rid>:<ts>") in, the results
// boxed under "eb:probe-res:<rid>" out. It runs in its own goroutine.
func (p *probeHub) handle(msg message, out *outbox) {
	ts, ok := parseTs(msg.Ts)
	if !ok || msg.Rid == "" || len(msg.Rid) > 64 {
		return
	}
	if !tsInWindow(ts) {
		debugf("probe %s: timestamp out of window", msg.Rid)
		return
	}
	data, err := b64.DecodeString(msg.D)
	if err != nil {
		return
	}
	pt, err := unbox(p.auth, data, "eb:probe:"+msg.Rid+":"+strconv.FormatInt(ts, 10))
	if err != nil {
		debugf("probe %s: authentication failed", msg.Rid)
		return
	}
	if !p.nonces.claim(msg.Rid) {
		return
	}
	var req struct {
		Kind    string   `json:"kind"`
		Targets []string `json:"targets"`
	}
	if json.Unmarshal(pt, &req) != nil || len(req.Targets) > maxProbeTargets {
		return
	}
	var plain []byte
	switch req.Kind {
	case "", "ping":
		plain, _ = json.Marshal(map[string]any{"r": probeAll(req.Targets, ping)})
	case "ifaces":
		plain, _ = json.Marshal(map[string]any{"ifaces": listIfaces(systemIfaces)})
	default:
		return
	}
	boxed, err := box(p.auth, plain, "eb:probe-res:"+msg.Rid)
	if err != nil {
		return
	}
	out.send(message{T: "probe.res", Rid: msg.Rid, D: b64.EncodeToString(boxed)})
}

// probeAll pings every valid address (a few at a time); anything that is not a plain IP
// address is left out of the answer.
func probeAll(targets []string, pinger func(netip.Addr) probeResult) map[string]probeResult {
	results := map[string]probeResult{}
	var mu sync.Mutex
	var wg sync.WaitGroup
	sem := make(chan struct{}, probeParallel)
	for _, t := range targets {
		addr, err := netip.ParseAddr(t)
		if err != nil || addr.Zone() != "" || addr.IsUnspecified() || addr.IsMulticast() {
			continue
		}
		mu.Lock()
		_, dup := results[t]
		results[t] = probeResult{}
		mu.Unlock()
		if dup {
			continue
		}
		wg.Add(1)
		sem <- struct{}{}
		go func(key string, a netip.Addr) {
			defer wg.Done()
			defer func() { <-sem }()
			r := pinger(a)
			mu.Lock()
			results[key] = r
			mu.Unlock()
		}(t, addr)
	}
	wg.Wait()
	return results
}

var pingTime = regexp.MustCompile(`time[=<]\s*([0-9.]+)\s*ms`)

// pingArgs is the system ping command for one echo request with a short timeout.
func pingArgs(addr netip.Addr) (string, []string) {
	ip := addr.Unmap().String()
	v6 := addr.Unmap().Is6()
	switch runtime.GOOS {
	case "darwin":
		if v6 {
			return "ping6", []string{"-n", "-c", "1", ip}
		}
		return "ping", []string{"-n", "-c", "1", "-t", "2", ip}
	default: // Linux (iputils, busybox)
		args := []string{"-n", "-c", "1", "-W", "2"}
		if v6 {
			args = append(args, "-6")
		}
		return "ping", append(args, ip)
	}
}

// ping sends one echo request; a missing ping command or a timeout reads as unreachable.
func ping(addr netip.Addr) probeResult {
	ctx, cancel := context.WithTimeout(context.Background(), probeTimeout)
	defer cancel()
	name, args := pingArgs(addr)
	cmd := exec.CommandContext(ctx, name, args...)
	start := time.Now()
	outb, err := cmd.Output()
	if err != nil {
		return probeResult{}
	}
	r := probeResult{Up: true, Ms: float64(time.Since(start).Microseconds()) / 1000}
	if m := pingTime.FindSubmatch(outb); m != nil {
		if v, err := strconv.ParseFloat(string(m[1]), 64); err == nil {
			r.Ms = v
		}
	}
	return r
}

// ifaceInfo is one network interface as reported to the owner's browser.
type ifaceInfo struct {
	Name    string   `json:"name"`
	Up      bool     `json:"up"`
	Running bool     `json:"running"`
	MTU     int      `json:"mtu"`
	MAC     string   `json:"mac,omitempty"`
	Addrs   []string `json:"addrs"`
}

// ifaceSource gives the interfaces and the addresses of each one (net.Interfaces + Addrs).
type ifaceSource func() ([]net.Interface, func(net.Interface) ([]net.Addr, error), error)

func systemIfaces() ([]net.Interface, func(net.Interface) ([]net.Addr, error), error) {
	list, err := net.Interfaces()
	return list, func(i net.Interface) ([]net.Addr, error) { return i.Addrs() }, err
}

// listIfaces describes the machine's interfaces, at most maxProbeIfaces of them with at most
// maxIfaceAddrs addresses each, as "address/prefix". Nothing is executed.
func listIfaces(src ifaceSource) []ifaceInfo {
	out := []ifaceInfo{}
	list, addrsOf, err := src()
	if err != nil {
		return out
	}
	for _, i := range list {
		if len(out) >= maxProbeIfaces {
			break
		}
		info := ifaceInfo{
			Name:    i.Name,
			Up:      i.Flags&net.FlagUp != 0,
			Running: i.Flags&net.FlagRunning != 0,
			MTU:     i.MTU,
			MAC:     i.HardwareAddr.String(),
			Addrs:   []string{},
		}
		addrs, _ := addrsOf(i)
		for _, a := range addrs {
			if len(info.Addrs) >= maxIfaceAddrs {
				break
			}
			if n, ok := a.(*net.IPNet); ok {
				ones, _ := n.Mask.Size()
				info.Addrs = append(info.Addrs, n.IP.String()+"/"+strconv.Itoa(ones))
			} else {
				info.Addrs = append(info.Addrs, a.String())
			}
		}
		out = append(out, info)
	}
	return out
}
