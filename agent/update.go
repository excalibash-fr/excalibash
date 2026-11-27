package main

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// Self-update. The trust anchor is an Ed25519 public key compiled into the binary (-ldflags
// "-X main.updatePubKey=<base64 of the 32 raw bytes>"); an agent built without one refuses to
// update itself. The server only distributes files: the release manifest (agent-manifest.json,
// with the SHA-256 and size of each platform's binary) is signed offline with the private key,
// so a compromised server can neither make the agent run a binary of its own nor an older one.
// The request itself is boxed under the machine auth key, exactly like a probe: whoever may open
// a shell on the machine may ask for an update, which grants nothing since the payload is the
// signed official binary.

// updatePubKey is set at build time (base64, 32 raw bytes). Empty: self-update is disabled.
var updatePubKey string

const (
	updateNewName = ".excalibash-agent.new"
	updateOldName = ".excalibash-agent.old"
	// Largest binary accepted, whatever the manifest says.
	maxUpdateBinary = 64 << 20
	maxManifestSize = 64 << 10
	manifestName    = "agent-manifest.json"
	// A freshly updated process must be connected within this time or it rolls back.
	trialWindow = 120 * time.Second
	// Time given to the outbox to deliver the "restarting" frame before exec.
	flushGrace = 300 * time.Millisecond

	envTrial      = "EXCALIBASH_UPDATE_TRIAL"      // set by the old process: version it came from
	envRolledBack = "EXCALIBASH_UPDATE_ROLLEDBACK" // set by a rollback: reported in the hello
	envAllowDev   = "EXCALIBASH_ALLOW_DEV_UPDATE"  // tests only: let a "dev" build update itself

	noKeyMessage = "mise à jour automatique désactivée pour cet agent (aucune clé de signature intégrée)"
)

// manifestEntry is one platform's binary in a signed release manifest.
type manifestEntry struct {
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size"`
}

// releaseManifest is agent-manifest.json; its signature covers the exact bytes of the file.
type releaseManifest struct {
	Version string                   `json:"version"`
	Date    string                   `json:"date"`
	Files   map[string]manifestEntry `json:"files"`
}

// parseUpdateKey decodes the build-time public key ("" = none, nil key and nil error).
func parseUpdateKey(s string) (ed25519.PublicKey, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil, nil
	}
	b, err := base64.StdEncoding.DecodeString(s)
	if err != nil || len(b) != ed25519.PublicKeySize {
		return nil, errors.New("clé de signature intégrée invalide")
	}
	return ed25519.PublicKey(b), nil
}

// verifyManifest checks the detached signature (base64 Ed25519 over the exact manifest bytes)
// and only then parses the manifest.
func verifyManifest(pub ed25519.PublicKey, raw, sigB64 []byte) (*releaseManifest, error) {
	if len(pub) != ed25519.PublicKeySize {
		return nil, errors.New(noKeyMessage)
	}
	sig, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(sigB64)))
	if err != nil || len(sig) != ed25519.SignatureSize || !ed25519.Verify(pub, raw, sig) {
		return nil, errors.New("signature de la version invalide : mise à jour refusée")
	}
	var m releaseManifest
	if err := json.Unmarshal(raw, &m); err != nil || m.Version == "" || m.Files == nil {
		return nil, errors.New("manifeste de version illisible")
	}
	return &m, nil
}

// parsedVersion is a semver-ish version: numeric core and an optional pre-release suffix.
type parsedVersion struct {
	core [3]int
	pre  string
}

func parseVersion(s string) (parsedVersion, bool) {
	var v parsedVersion
	s = strings.TrimPrefix(strings.TrimSpace(s), "v")
	if i := strings.IndexByte(s, '+'); i >= 0 { // build metadata does not count
		s = s[:i]
	}
	core, pre, _ := strings.Cut(s, "-")
	v.pre = pre
	parts := strings.Split(core, ".")
	if len(parts) == 0 || len(parts) > 3 {
		return v, false
	}
	for i, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil || n < 0 || p == "" {
			return v, false
		}
		v.core[i] = n
	}
	return v, true
}

// comparePre orders pre-release suffixes: none is greater than any; otherwise dot-separated
// identifiers, numeric ones numerically (semver 2.0 §11).
func comparePre(a, b string) int {
	if a == b {
		return 0
	}
	if a == "" {
		return 1
	}
	if b == "" {
		return -1
	}
	as, bs := strings.Split(a, "."), strings.Split(b, ".")
	for i := 0; i < len(as) && i < len(bs); i++ {
		an, aerr := strconv.Atoi(as[i])
		bn, berr := strconv.Atoi(bs[i])
		switch {
		case aerr == nil && berr == nil:
			if an != bn {
				return map[bool]int{true: -1, false: 1}[an < bn]
			}
		case aerr == nil:
			return -1
		case berr == nil:
			return 1
		default:
			if c := strings.Compare(as[i], bs[i]); c != 0 {
				return c
			}
		}
	}
	return map[bool]int{true: -1, false: 1}[len(as) < len(bs)]
}

// compareVersions returns -1, 0 or 1; an error when either side is not a version.
func compareVersions(a, b string) (int, error) {
	va, ok := parseVersion(a)
	if !ok {
		return 0, fmt.Errorf("version %q non reconnue", a)
	}
	vb, ok := parseVersion(b)
	if !ok {
		return 0, fmt.Errorf("version %q non reconnue", b)
	}
	for i := range va.core {
		if va.core[i] != vb.core[i] {
			return map[bool]int{true: -1, false: 1}[va.core[i] < vb.core[i]], nil
		}
	}
	return comparePre(va.pre, vb.pre), nil
}

// checkUpgrade refuses anything but a strictly newer version (no downgrade, no reinstall).
// A "dev" build only updates itself when allowDev is set (tests).
func checkUpgrade(current, candidate string, allowDev bool) error {
	if current == "dev" {
		if !allowDev {
			return errors.New("agent de développement (version « dev ») : mise à jour automatique refusée")
		}
		current = "0.0.0"
	}
	c, err := compareVersions(candidate, current)
	if err != nil {
		return err
	}
	switch {
	case c == 0:
		return errors.New("l'agent est déjà à jour")
	case c < 0:
		return fmt.Errorf("version %s plus ancienne que la version installée %s : retour en arrière refusé", candidate, current)
	}
	return nil
}

// swapState lets a swapped executable be put back.
type swapState struct{ exe, old string }

// restore puts the previous executable back over the new one.
func (s *swapState) restore() error { return os.Rename(s.old, s.exe) }

type updater struct {
	auth     []byte
	key      ed25519.PublicKey
	keyErr   error
	current  string
	allowDev bool
	base     string // http(s)://host[/prefix] of the server, set once the endpoint is known
	client   *http.Client
	replay   *nonceSet

	exePath    func() (string, error)
	platform   string
	execFn     func(argv0 string, argv, env []string) error
	environ    func() []string
	beforeExec func() // closes the shells
	flush      func(*outbox)

	mu   sync.Mutex
	busy bool
}

func newUpdater(auth []byte) *updater {
	key, err := parseUpdateKey(updatePubKey)
	return &updater{
		auth: auth, key: key, keyErr: err, current: version, replay: newNonceSet(maxUpdateNonces),
		allowDev: os.Getenv(envAllowDev) == "1",
		client:   &http.Client{},
		exePath:  realExecutable,
		platform: runtime.GOOS + "-" + runtime.GOARCH,
		execFn:   syscall.Exec,
		environ:  os.Environ,
		flush:    flushOutbox,
	}
}

// configure points the updater at the server the agent is connected to, with the same TLS
// settings (pin or --insecure) as the websocket.
func (u *updater) configure(endpoint string, insecure bool, pin string) error {
	base, err := updateBase(endpoint)
	if err != nil {
		return err
	}
	u.base = base
	u.client = &http.Client{
		Transport: httpTransport(insecure, pin),
		// The files come from the server the agent talks to, nowhere else.
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if req.URL.Host != via[0].URL.Host {
				return errors.New("redirection vers un autre hôte refusée")
			}
			if len(via) > 5 {
				return errors.New("trop de redirections")
			}
			return nil
		},
	}
	return nil
}

// updateBase turns the agent websocket URL (ws(s)://host/prefix/agent) into the server's HTTP base.
func updateBase(endpoint string) (string, error) {
	u, err := url.Parse(endpoint)
	if err != nil {
		return "", err
	}
	switch u.Scheme {
	case "ws":
		u.Scheme = "http"
	case "wss":
		u.Scheme = "https"
	default:
		return "", fmt.Errorf("unsupported scheme %q", u.Scheme)
	}
	u.Path = strings.TrimSuffix(strings.TrimRight(u.Path, "/"), "/agent")
	u.RawQuery, u.Fragment = "", ""
	return strings.TrimRight(u.String(), "/"), nil
}

// realExecutable is the path of the running binary, symlinks resolved.
func realExecutable() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	return filepath.EvalSymlinks(exe)
}

// flushOutbox gives the writer goroutine time to put queued frames on the wire.
func flushOutbox(out *outbox) {
	deadline := time.Now().Add(3 * time.Second)
	for len(out.ch) > 0 && time.Now().Before(deadline) {
		select {
		case <-out.done:
			return
		case <-time.After(20 * time.Millisecond):
		}
	}
	time.Sleep(flushGrace)
}

// reporter boxes progress frames under "eb:update-res:<rid>"; n orders them for the browser.
type reporter struct {
	auth []byte
	rid  string
	out  *outbox
	n    int
}

func (r *reporter) send(phase, text string, end bool, extra map[string]any) {
	r.n++
	pl := map[string]any{"n": r.n, "phase": phase}
	if text != "" {
		pl["msg"] = text
	}
	for k, v := range extra {
		pl[k] = v
	}
	plain, _ := json.Marshal(pl)
	boxed, err := box(r.auth, plain, "eb:update-res:"+r.rid)
	if err != nil {
		return
	}
	r.out.send(message{T: "update.res", Rid: r.rid, D: b64.EncodeToString(boxed), End: end})
}

// handle answers one update request: box(auth, {op:"update"}, "eb:update:<rid>:<ts>") in,
// progress frames boxed under "eb:update-res:<rid>" out. Runs in its own goroutine.
func (u *updater) handle(msg message, out *outbox) {
	ts, ok := parseTs(msg.Ts)
	if !ok || msg.Rid == "" || len(msg.Rid) > 64 {
		return
	}
	if !tsInWindow(ts) {
		debugf("update %s: timestamp out of window", msg.Rid)
		return
	}
	data, err := b64.DecodeString(msg.D)
	if err != nil {
		return
	}
	pt, err := unbox(u.auth, data, "eb:update:"+msg.Rid+":"+strconv.FormatInt(ts, 10))
	if err != nil {
		debugf("update %s: authentication failed", msg.Rid)
		return
	}
	if !u.replay.claim(msg.Rid) {
		return
	}
	var req struct {
		Op string `json:"op"`
	}
	if json.Unmarshal(pt, &req) != nil || req.Op != "update" {
		return
	}
	rep := &reporter{auth: u.auth, rid: msg.Rid, out: out}

	u.mu.Lock()
	if u.busy {
		u.mu.Unlock()
		rep.send("error", "une mise à jour est déjà en cours", true, nil)
		return
	}
	u.busy = true
	u.mu.Unlock()
	defer func() {
		u.mu.Lock()
		u.busy = false
		u.mu.Unlock()
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	sw, newVersion, err := u.install(ctx, rep)
	if err != nil {
		log.Printf("update: %v", err)
		rep.send("error", err.Error(), true, nil)
		return
	}
	log.Printf("update: %s → %s installed, restarting", u.current, newVersion)
	rep.send("restarting", "redémarrage de l'agent", false, map[string]any{"version": newVersion})
	u.flush(out)
	if u.beforeExec != nil {
		u.beforeExec()
	}
	env := trialEnv(u.environ(), u.current)
	if err := u.execFn(sw.exe, os.Args, env); err != nil {
		rerr := sw.restore()
		msg := "redémarrage impossible : " + err.Error()
		if rerr != nil {
			msg += " (restauration impossible : " + rerr.Error() + ")"
		}
		log.Printf("update: %s", msg)
		rep.send("error", msg, true, nil)
	}
}

// install runs the whole procedure up to and including the swap of the executable, and returns
// what is needed to undo it plus the new version. It never execs.
func (u *updater) install(ctx context.Context, rep *reporter) (*swapState, string, error) {
	if u.keyErr != nil {
		return nil, "", u.keyErr
	}
	if u.key == nil {
		return nil, "", errors.New(noKeyMessage)
	}
	if u.current == "dev" && !u.allowDev {
		return nil, "", errors.New("agent de développement (version « dev ») : mise à jour automatique refusée")
	}
	if u.base == "" {
		return nil, "", errors.New("adresse du serveur inconnue")
	}
	rep.send("check", "vérification de la version disponible", false, nil)
	raw, err := u.fetch(ctx, u.base+"/downloads/"+manifestName, maxManifestSize)
	if err != nil {
		return nil, "", fmt.Errorf("manifeste : %w", err)
	}
	sig, err := u.fetch(ctx, u.base+"/downloads/"+manifestName+".sig", 4096)
	if err != nil {
		return nil, "", fmt.Errorf("signature : %w", err)
	}
	m, err := verifyManifest(u.key, raw, sig)
	if err != nil {
		return nil, "", err
	}
	if err := checkUpgrade(u.current, m.Version, u.allowDev); err != nil {
		return nil, "", err
	}
	entry, ok := m.Files[u.platform]
	if !ok {
		return nil, "", fmt.Errorf("aucun binaire %s dans la version %s", u.platform, m.Version)
	}
	if entry.Size <= 0 || entry.Size > maxUpdateBinary || len(entry.SHA256) != sha256.Size*2 {
		return nil, "", errors.New("entrée du manifeste invalide pour " + u.platform)
	}
	want, err := hex.DecodeString(entry.SHA256)
	if err != nil {
		return nil, "", errors.New("empreinte du manifeste invalide")
	}
	exe, err := u.exePath()
	if err != nil {
		return nil, "", fmt.Errorf("chemin de l'agent : %w", err)
	}
	dir := filepath.Dir(exe)
	tmp, old := filepath.Join(dir, updateNewName), filepath.Join(dir, updateOldName)
	rep.send("download", "téléchargement de la version "+m.Version, false, map[string]any{"version": m.Version, "size": entry.Size})
	file := "excalibash-agent-" + u.platform
	if err := u.download(ctx, u.base+"/downloads/"+file, tmp, entry.Size, want); err != nil {
		os.Remove(tmp)
		return nil, "", err
	}
	rep.send("install", "installation de la version "+m.Version, false, nil)
	// The new file takes the permissions of the one it replaces.
	mode := os.FileMode(0o700)
	if st, err := os.Stat(exe); err == nil {
		mode = st.Mode().Perm() | 0o100
	}
	if err := os.Chmod(tmp, mode); err != nil {
		os.Remove(tmp)
		return nil, "", err
	}
	os.Remove(old)
	if err := os.Rename(exe, old); err != nil {
		os.Remove(tmp)
		return nil, "", fmt.Errorf("remplacement impossible (%s) : %w", dir, err)
	}
	if err := os.Rename(tmp, exe); err != nil {
		os.Rename(old, exe)
		os.Remove(tmp)
		return nil, "", fmt.Errorf("remplacement impossible : %w", err)
	}
	return &swapState{exe: exe, old: old}, m.Version, nil
}

// fetch downloads a small file from the server, at most max bytes.
func (u *updater) fetch(ctx context.Context, target string, max int64) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return nil, err
	}
	resp, err := u.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, max+1))
	if err != nil {
		return nil, err
	}
	if int64(len(b)) > max {
		return nil, errors.New("fichier trop volumineux")
	}
	return b, nil
}

// download writes the binary to dst (0700), refusing more bytes than the manifest announced
// and any hash that is not the signed one.
func (u *updater) download(ctx context.Context, target, dst string, size int64, want []byte) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return err
	}
	resp, err := u.client.Do(req)
	if err != nil {
		return fmt.Errorf("téléchargement : %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("téléchargement : HTTP %d", resp.StatusCode)
	}
	if resp.ContentLength > size {
		return errors.New("binaire plus gros que la taille signée")
	}
	os.Remove(dst)
	f, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o700)
	if err != nil {
		return fmt.Errorf("écriture impossible : %w", err)
	}
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(f, h), io.LimitReader(resp.Body, size+1))
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return fmt.Errorf("téléchargement : %w", err)
	}
	if n != size {
		return fmt.Errorf("taille du binaire (%d) différente de la taille signée (%d)", n, size)
	}
	if subtle.ConstantTimeCompare(h.Sum(nil), want) != 1 {
		return errors.New("empreinte du binaire différente de celle signée : mise à jour refusée")
	}
	return nil
}

// ---- Trial run and rollback ---------------------------------------------------

// trialEnv is the environment of the re-exec'd agent: a trial marker for the version it replaces.
func trialEnv(env []string, oldVersion string) []string {
	out := filterEnv(env, envTrial, envRolledBack)
	return append(out, envTrial+"="+oldVersion)
}

// rollbackEnv is the environment of the restored agent: no trial, and a note for its hello.
func rollbackEnv(env []string) []string {
	out := filterEnv(env, envTrial, envRolledBack)
	return append(out, envRolledBack+"=1")
}

func filterEnv(env []string, names ...string) []string {
	out := make([]string, 0, len(env)+1)
next:
	for _, kv := range env {
		for _, n := range names {
			if strings.HasPrefix(kv, n+"=") {
				continue next
			}
		}
		out = append(out, kv)
	}
	return out
}

type trialAction int

const (
	trialWait     trialAction = iota // not connected yet, time left
	trialCommit                      // connected: keep the new version, drop the old file
	trialRollback                    // out of time, not connected, an old binary to go back to
	trialStay                        // out of time but nothing to go back to
)

// trialDecision is the whole rollback policy: a process started by an update must have
// connected (connection and hello) within the window, or the previous binary comes back.
func trialDecision(connected bool, elapsed, window time.Duration, oldExists bool) trialAction {
	switch {
	case connected:
		return trialCommit
	case elapsed < window:
		return trialWait
	case oldExists:
		return trialRollback
	default:
		return trialStay
	}
}

// trial watches a process started by an update.
type trial struct {
	oldVersion string
	exe, old   string
	started    time.Time
	window     time.Duration
	execFn     func(argv0 string, argv, env []string) error
	environ    func() []string

	once sync.Once
	done chan struct{}
}

// startTrial returns the watchdog of a process started by an update (nil for a normal start)
// and removes the marker from the environment, so shells do not inherit it.
func startTrial() *trial {
	oldVersion, ok := os.LookupEnv(envTrial)
	if !ok {
		return nil
	}
	os.Unsetenv(envTrial)
	exe, err := realExecutable()
	if err != nil {
		return nil
	}
	t := &trial{
		oldVersion: oldVersion, exe: exe, old: filepath.Join(filepath.Dir(exe), updateOldName),
		started: time.Now(), window: trialWindow, execFn: syscall.Exec, environ: os.Environ,
		done: make(chan struct{}),
	}
	go t.watch()
	return t
}

// succeed is called once the agent is connected and has said hello; it makes the update permanent.
func (t *trial) succeed() {
	if t == nil {
		return
	}
	t.once.Do(func() {
		close(t.done)
		os.Remove(t.old)
		log.Printf("update: now running %s (was %s)", version, t.oldVersion)
	})
}

func (t *trial) watch() {
	select {
	case <-t.done:
		return
	case <-time.After(t.window):
	}
	t.once.Do(func() {
		_, err := os.Stat(t.old)
		if trialDecision(false, time.Since(t.started), t.window, err == nil) != trialRollback {
			close(t.done)
			return
		}
		close(t.done)
		log.Printf("update: not connected %s after the update, going back to %s", t.window, t.oldVersion)
		if err := t.rollback(); err != nil {
			log.Printf("update: rollback failed: %v", err)
		}
	})
}

// rollback puts the previous binary back and starts it.
func (t *trial) rollback() error {
	if err := os.Rename(t.old, t.exe); err != nil {
		return err
	}
	return t.execFn(t.exe, os.Args, rollbackEnv(t.environ()))
}

// rolledBackNote is what the restored agent adds to its hello; the variable is consumed.
func rolledBackNote() string {
	if os.Getenv(envRolledBack) != "1" {
		return ""
	}
	os.Unsetenv(envRolledBack)
	return "mise à jour annulée"
}
