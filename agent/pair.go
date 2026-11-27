package main

import (
	"bytes"
	"crypto/ecdh"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"golang.org/x/crypto/argon2"
)

// Pairing with a short code typed on the machine (no copy-paste needed). The agent makes its
// own key pair here; the owner checks the fingerprint shown below against the one in the browser,
// then the browser seals the machine auth key to this public key. The private key never leaves.
//
// The seal alone is anonymous: the server relays the agent's public key and the code, so it could
// seal an auth key of its own choosing. The agent also shows a confirmation code that only goes
// from its screen to the owner's browser, by hand; the browser seals auth ‖ HMAC(confirm, auth ‖ pub),
// and an auth key the server made up lacks a valid tag. Online, the server gets one guess per
// pairing: the agent takes a single seal and gives up on the first bad tag.
//
// Limit: the tag is not a substitute for the fingerprint check. A server that also substitutes
// its own key for this agent's (and an owner who approves without comparing fingerprints) gets
// auth ‖ HMAC(confirm, auth ‖ serverPub) sealed to itself, and can grind the ~40-bit code offline,
// then seal an auth key this agent would accept. See docs/SECURITY.md, "Appairage par code".

const pairTimeout = 10 * time.Minute

const confirmAlphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ" // no 0/O, 1/I/L
const confirmLen = 8

// newConfirmCode is a variable so tests can know the code the owner would read.
var newConfirmCode = randomConfirmCode

// randomConfirmCode: 7 random letters and a check letter, so a typo is caught in the browser
// before anything is sent (a wrong code would otherwise leave a machine that never connects).
func randomConfirmCode() string {
	b := make([]byte, confirmLen-1)
	for i := range b {
		var r [1]byte
		for {
			_, _ = rand.Read(r[:])
			// 248 = 8 × 31: rejection sampling keeps the letters uniform.
			if r[0] < 248 {
				break
			}
		}
		b[i] = confirmAlphabet[int(r[0])%len(confirmAlphabet)]
	}
	return string(b) + string(confirmCheck(string(b)))
}

// confirmCheck: Σ (i+1)·index(c_i) mod 31. With distinct weights and a prime modulus it catches
// any single wrong letter and any swap of two neighbours. Same formula in web/src/crypto.ts.
func confirmCheck(body string) byte {
	sum := 0
	for i := 0; i < len(body); i++ {
		sum += (i + 1) * strings.IndexByte(confirmAlphabet, body[i])
	}
	return confirmAlphabet[sum%len(confirmAlphabet)]
}

// pairTag binds the auth key to this agent's key under the confirmation code. The code (~38 bits)
// is first stretched with Argon2id, salted with the agent's key: a server that got a tag by
// substituting its own key (an owner who skipped the fingerprint) can't search the code offline.
// Same parameters as the account KDF and web/src/crypto.ts.
func pairTag(confirm string, auth, pub []byte) []byte {
	k := argon2.IDKey([]byte(normalizeCode(confirm)), pub, 3, 64*1024, 1, 32)
	m := hmac.New(sha256.New, k)
	m.Write(auth)
	m.Write(pub)
	return m.Sum(nil)
}

// savedConfig is what a paired agent keeps on disk (0600).
type savedConfig struct {
	Server string `json:"server"`
	Token  string `json:"token"`
	Auth   string `json:"auth"` // machine auth key, base64url
	Pub    string `json:"pub"`  // public key, for the fingerprint in logs
	Name   string `json:"name,omitempty"`
	Pin    string `json:"pin,omitempty"` // server public key pin (self-signed certificate), see pin.go
}

func defaultConfigPath() string {
	dir := os.Getenv("XDG_CONFIG_HOME")
	if dir == "" {
		home, _ := os.UserHomeDir()
		dir = filepath.Join(home, ".config")
	}
	return filepath.Join(dir, "excalibash", "agent.json")
}

func loadConfig(path string) (savedConfig, error) {
	var c savedConfig
	b, err := os.ReadFile(path)
	if err != nil {
		return c, err
	}
	if err := json.Unmarshal(b, &c); err != nil {
		return c, err
	}
	if c.Server == "" || c.Token == "" || c.Auth == "" {
		return c, errors.New("configuration incomplète")
	}
	return c, nil
}

func saveConfig(path string, c savedConfig) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	// MkdirAll leaves an existing directory as it was; tighten ours (not a --config ./x.json's).
	if filepath.Base(dir) == "excalibash" {
		if err := os.Chmod(dir, 0o700); err != nil {
			return err
		}
	}
	b, _ := json.MarshalIndent(c, "", "  ")
	// A fresh file: WriteFile would keep the mode of a leftover .tmp, or follow a symlink planted there.
	tmp := path + ".tmp"
	_ = os.Remove(tmp)
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	if _, err := f.Write(b); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

var codeChars = regexp.MustCompile(`[^A-Z0-9]`)

// normalizeCode accepts "7kq-4fd", "7KQ4FD"…
func normalizeCode(code string) string {
	return codeChars.ReplaceAllString(strings.ToUpper(code), "")
}

// httpBase turns the server URL into the http(s) base used for the pairing API.
func httpBase(server string) (string, error) {
	if !strings.Contains(server, "://") {
		server = "https://" + server
	}
	u, err := url.Parse(server)
	if err != nil || u.Host == "" {
		return "", fmt.Errorf("adresse de serveur invalide : %q", server)
	}
	switch u.Scheme {
	case "ws":
		u.Scheme = "http"
	case "wss":
		u.Scheme = "https"
	}
	return u.Scheme + "://" + u.Host, nil
}

func pair(server, rawCode, name string, insecure bool, pin string) (savedConfig, error) {
	code := normalizeCode(rawCode)
	if len(code) < 6 {
		return savedConfig{}, errors.New("code d'appairage invalide")
	}
	base, err := httpBase(server)
	if err != nil {
		return savedConfig{}, err
	}
	client := &http.Client{Timeout: 20 * time.Second, Transport: httpTransport(insecure, pin)}
	priv, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		return savedConfig{}, err
	}
	pub := b64.EncodeToString(priv.PublicKey().Bytes())
	endpoint := base + "/api/pair/" + code

	body, _ := json.Marshal(map[string]string{"pub": pub, "name": name})
	resp, err := client.Post(endpoint, "application/json", bytes.NewReader(body))
	if err != nil {
		return savedConfig{}, fmt.Errorf("serveur injoignable : %w", err)
	}
	resp.Body.Close()
	switch resp.StatusCode {
	case http.StatusAccepted, http.StatusOK:
	case http.StatusNotFound, http.StatusGone:
		return savedConfig{}, errors.New("code inconnu, expiré ou déjà utilisé : génère-en un nouveau dans Excalibash")
	default:
		return savedConfig{}, fmt.Errorf("le serveur a refusé l'appairage (%d)", resp.StatusCode)
	}

	confirm := newConfirmCode()
	fmt.Fprintf(os.Stderr, "\n  Empreinte de cette machine :\n\n      %s\n\n", fingerprint(priv.PublicKey().Bytes()))
	fmt.Fprintln(os.Stderr, "  Vérifie qu'Excalibash affiche exactement la même, puis tape ce code de confirmation :")
	fmt.Fprintf(os.Stderr, "\n      Code de confirmation : %s-%s\n\n", confirm[:4], confirm[4:])
	fmt.Fprintln(os.Stderr, "  En attente de validation…")

	deadline := time.Now().Add(pairTimeout)
	for time.Now().Before(deadline) {
		time.Sleep(2 * time.Second)
		resp, err := client.Get(endpoint + "?pub=" + url.QueryEscape(pub))
		if err != nil {
			continue
		}
		var res struct {
			Token      string `json:"token"`
			SealedAuth string `json:"sealedAuth"`
		}
		decodeErr := json.NewDecoder(io.LimitReader(resp.Body, 8<<10)).Decode(&res)
		resp.Body.Close()
		switch resp.StatusCode {
		case http.StatusAccepted:
			continue
		case http.StatusOK:
		case http.StatusNotFound, http.StatusGone:
			return savedConfig{}, errors.New("appairage refusé ou expiré dans Excalibash")
		default:
			continue
		}
		if decodeErr != nil || res.Token == "" {
			return savedConfig{}, errors.New("réponse d'appairage invalide")
		}
		sealed, err := b64.DecodeString(res.SealedAuth)
		if err != nil {
			return savedConfig{}, errCrypto
		}
		opened, err := unseal(priv, sealed, "eb:pair:"+code)
		if err != nil || len(opened) != keyLen+sha256.Size {
			return savedConfig{}, errors.New("clé de la machine non authentique : appairage annulé")
		}
		auth, tag := opened[:keyLen], opened[keyLen:]
		if !hmac.Equal(tag, pairTag(confirm, auth, priv.PublicKey().Bytes())) {
			return savedConfig{}, errors.New("code de confirmation faux, ou clé ne venant pas du navigateur du propriétaire : appairage annulé (recommence avec un nouveau code)")
		}
		return savedConfig{Server: base, Token: res.Token, Auth: b64.EncodeToString(auth), Pub: pub, Name: name, Pin: pin}, nil
	}
	return savedConfig{}, errors.New("délai dépassé : personne n'a validé l'appairage")
}

func pubFromB64(s string) []byte {
	b, err := b64.DecodeString(s)
	if err != nil {
		return nil
	}
	if _, err := ecdh.X25519().NewPublicKey(b); err != nil {
		return nil
	}
	return b
}
