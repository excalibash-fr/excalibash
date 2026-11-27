package main

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// Packet capture on the machine: tcpdump is run directly (never through a shell) and its output
// is streamed like a download. Interface and filter are validated first; see docs/SECURITY.md.

const (
	captureDefaultSeconds = 30
	captureMaxSeconds     = 300
	captureDefaultBytes   = 20 << 20
	captureMaxBytes       = 50 << 20
	captureFlush          = 300 * time.Millisecond
)

var (
	ifaceRe  = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:@-]{0,31}$`) // mirrors web/src/validators.ts
	filterRe = regexp.MustCompile(`^[A-Za-z0-9._:/!()&|<>=-]{1,64}$`)    // mirrors web/src/validators.ts
)

// validateCapture checks the interface and filter, and returns the tcpdump arguments. Nothing
// user-controlled reaches a shell: the arguments are passed to exec directly. `exclude` is the
// agent's own connection to the server, left out of the capture.
func validateCapture(iface, filter string, exclude *serverLink) ([]string, error) {
	if !ifaceRe.MatchString(iface) {
		return nil, errors.New("interface invalide")
	}
	args := []string{"-i", iface, "-U", "-n", "-s", "0", "-w", "-", "--"}
	tokens := strings.Fields(filter)
	if len(tokens) > 32 {
		return nil, errors.New("filtre trop long (32 mots au maximum)")
	}
	for _, t := range tokens {
		if strings.HasPrefix(t, "-") || !filterRe.MatchString(t) {
			return nil, errors.New("filtre invalide : caractères ou option non autorisés")
		}
	}
	if exclude == nil || !exclude.remote.IsValid() {
		return append(args, tokens...), nil
	}
	// Without this, capturing on the interface that reaches the server captures the capture
	// itself as it is uploaded, and the file fills up in seconds with its own packets.
	self := []string{"not", "(", "host", exclude.remote.Addr().Unmap().String(), "and", "tcp", "port", strconv.Itoa(int(exclude.remote.Port())), "and", "tcp", "port", strconv.Itoa(int(exclude.local.Port())), ")"}
	if len(tokens) == 0 {
		return append(args, self...), nil
	}
	args = append(args, "(")
	args = append(args, tokens...)
	args = append(args, ")", "and")
	return append(args, self...), nil
}

func findTcpdump() (string, error) {
	if p, err := exec.LookPath("tcpdump"); err == nil {
		return p, nil
	}
	for _, p := range []string{"/usr/sbin/tcpdump", "/sbin/tcpdump"} {
		if info, err := os.Stat(p); err == nil && info.Mode().IsRegular() {
			return p, nil
		}
	}
	return "", errors.New(errNoTcpdump)
}

type headBuffer struct {
	mu  sync.Mutex
	buf []byte
}

func (b *headBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if room := 4096 - len(b.buf); room > 0 {
		b.buf = append(b.buf, p[:min(room, len(p))]...)
	}
	return len(p), nil
}

const (
	errNoTcpdump = "tcpdump n'est pas installé sur la machine (apt install tcpdump)"
	errNoRights  = "Capture refusée : l'agent n'a pas le droit de capturer. Sur la machine : sudo setcap cap_net_raw,cap_net_admin=eip $(command -v tcpdump) — ou lance l'agent en root."
	// detailSep splits an error into the message shown first and tcpdump's own line, shown as details.
	detailSep = "\nDétail : "
)

var (
	noRightsRe   = regexp.MustCompile(`(?i)permission|not permitted|EPERM`)
	noDeviceRe   = regexp.MustCompile(`^tcpdump: (\S+): No such device exists`)
	tcpdumpNoise = []string{"tcpdump: verbose output suppressed", "tcpdump: listening on", "packets captured", "packets received", "packets dropped"}
)

// tcpdumpError turns tcpdump's stderr into a message for the user. It reads every line: the
// permission problem is often the second one ("lo: You don't have permission…" then
// "(socket: Operation not permitted)"), and the first line alone would hide the hint.
func tcpdumpError(stderr string) string {
	var lines []string
	for _, line := range strings.Split(stderr, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || slices.ContainsFunc(tcpdumpNoise, func(n string) bool { return strings.Contains(line, n) }) {
			continue
		}
		if len(line) > 200 {
			line = line[:200]
		}
		lines = append(lines, line)
	}
	if len(lines) == 0 {
		return "tcpdump s'est arrêté sans message"
	}
	detail := detailSep + strings.Join(lines[:min(len(lines), 3)], " / ")
	for _, l := range lines {
		if noRightsRe.MatchString(l) {
			return errNoRights + detail
		}
		if strings.Contains(l, "command not found") || strings.Contains(l, "executable file not found") {
			return errNoTcpdump + detail
		}
	}
	if m := noDeviceRe.FindStringSubmatch(lines[0]); m != nil {
		return "L'interface " + m[1] + " n'existe pas sur la machine." + detail
	}
	return lines[0]
}

func (h *fileHub) capture(x *xfer, op fileOp) {
	defer h.release(x)
	s := newStream(x)
	args, err := validateCapture(op.Iface, op.Filter, currentLink.Load())
	if err != nil {
		s.fail(err.Error())
		return
	}
	seconds, maxBytes := op.Seconds, op.MaxBytes
	if seconds == 0 {
		seconds = captureDefaultSeconds
	}
	if maxBytes == 0 {
		maxBytes = captureDefaultBytes
	}
	if seconds < 1 || seconds > captureMaxSeconds || maxBytes < 1 || maxBytes > captureMaxBytes {
		s.fail("durée (1 à 300 s) ou taille (50 Mio au maximum) invalide")
		return
	}
	bin, err := findTcpdump()
	if err != nil {
		s.fail(err.Error())
		return
	}
	ctx, cancel := context.WithTimeout(x.ctx, time.Duration(seconds)*time.Second)
	defer cancel()
	x.stop.Store(&cancel)
	cmd := exec.CommandContext(ctx, bin, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGTERM) } // flushes, then exits
	cmd.WaitDelay = 3 * time.Second
	var stderr headBuffer
	cmd.Stderr = &stderr
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		s.fail("lancement impossible")
		return
	}
	if err := cmd.Start(); err != nil {
		if errors.Is(err, exec.ErrNotFound) || errors.Is(err, os.ErrNotExist) {
			s.fail(errNoTcpdump)
			return
		}
		s.fail("lancement de tcpdump impossible : " + errText(err))
		return
	}
	defer func() { // whatever happens, nothing outlives the transfer
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		_ = cmd.Wait()
	}()

	data := make(chan []byte, 16)
	go func() {
		defer close(data)
		for {
			b := make([]byte, 64<<10)
			n, err := stdout.Read(b)
			if n > 0 {
				select {
				case data <- b[:n]:
				case <-x.ctx.Done():
					return
				}
			}
			if err != nil {
				return
			}
		}
	}()

	// The browser adds the date when it saves the file.
	name := "capture-" + op.Iface + ".pcap"
	pending := make([]byte, 0, fileChunk)
	first := true
	var total int64
	flush := func(end bool) bool {
		body := map[string]any{}
		if first {
			body["name"] = name
			first = false
		}
		ok := s.send(body, pending, end)
		pending = pending[:0]
		return ok
	}
	tick := time.NewTicker(captureFlush)
	defer tick.Stop()
	stopped := false
loop:
	for {
		select {
		case b, ok := <-data:
			if !ok {
				break loop
			}
			pending = append(pending, b...)
			total += int64(len(b))
			if len(pending) >= fileChunk && !flush(false) {
				return
			}
			if total >= maxBytes {
				stopped = true
				cancel()
				break loop
			}
		case <-tick.C:
			x.touch() // a quiet link is not an idle transfer; the duration limit bounds it
			if len(pending) > 0 && !flush(false) {
				return
			}
		case <-ctx.Done():
			stopped = true
			break loop
		}
	}
	if x.ctx.Err() != nil { // cancelled by the client or idle: nobody waits for the rest
		s.fail("capture annulée")
		return
	}
	if !stopped { // tcpdump ended by itself: success only if it produced a capture
		err := cmd.Wait()
		if err != nil && total == 0 {
			s.fail(tcpdumpError(string(stderr.buf)))
			return
		}
	}
	// Drain what tcpdump flushed while stopping.
	for b := range data {
		pending = append(pending, b...)
		total += int64(len(b))
		if len(pending) >= fileChunk && !flush(false) {
			return
		}
	}
	if total == 0 {
		s.fail(tcpdumpError(string(stderr.buf)))
		return
	}
	flush(true)
}
