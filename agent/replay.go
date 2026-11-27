package main

import (
	"encoding/json"
	"strconv"
	"sync"
	"time"
)

// Anti-replay building blocks shared by the request handlers (probe, file, http, ws.open).
// Every sealed request carries a millisecond timestamp bound into its AAD, and a request id.
// The timestamp confines a capture to a window of ±inputMaxSkew; within that window, a
// nonceSet remembers the ids already served so the same frame cannot be played twice.

const (
	// nonceLifetime is how long a recorded id is kept: longer than the whole timestamp window
	// (2 × inputMaxSkew), so a frame still inside the window is always remembered.
	nonceLifetime = inputMaxSkew * 2
	// noncePruneEvery spaces out the full scan of a nonce map.
	noncePruneEvery = 5 * time.Second
)

// Size caps of the nonce sets. Only authenticated frames are recorded, so filling a set takes
// a key holder; once full, new requests are refused (fail closed) until expired entries are
// pruned. Each entry costs roughly 100–200 bytes, so the caps bound memory to a few MB.
const (
	// maxProbeNonces: probes are user-triggered and rare; 4096 per nonceLifetime is far above use.
	maxProbeNonces = 4096
	// maxFileNonces: one id per file frame (chunks included); 32768 over ten minutes is ~55/s.
	maxFileNonces = 32768
	// maxWebNonces: one id per proxied HTTP request or WebSocket open, shared by both; a page
	// load can fire dozens of requests, so this one is larger (~110/s sustained over ten minutes).
	maxWebNonces = 65536
	// maxUpdateNonces: update requests are rare, owner-triggered actions.
	maxUpdateNonces = 1024
)

// nonceSet is a bounded, expiring set of request ids.
type nonceSet struct {
	mu        sync.Mutex
	seenAt    map[string]time.Time
	lastPrune time.Time
	max       int
	lifetime  time.Duration
	pruneGap  time.Duration
}

func newNonceSet(max int) *nonceSet {
	return &nonceSet{seenAt: map[string]time.Time{}, max: max, lifetime: nonceLifetime, pruneGap: noncePruneEvery}
}

// seen is a read-only pre-check: it reports whether k is already recorded. It is only an
// optimisation (concurrent identical frames can all pass it); claim is authoritative.
func (n *nonceSet) seen(k string) bool {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.prune(time.Now())
	_, ok := n.seenAt[k]
	return ok
}

// claim atomically checks and records k. It refuses an id already recorded, and any new id
// while the set is full. Call it only once the frame is authenticated, so a forged frame
// cannot burn an id or fill the set.
func (n *nonceSet) claim(k string) bool {
	n.mu.Lock()
	defer n.mu.Unlock()
	now := time.Now()
	n.prune(now)
	if _, ok := n.seenAt[k]; ok || len(n.seenAt) >= n.max {
		return false
	}
	n.seenAt[k] = now
	return true
}

// prune drops expired ids, with a full scan at most once per pruneGap. Caller holds n.mu.
func (n *nonceSet) prune(now time.Time) {
	if now.Sub(n.lastPrune) <= n.pruneGap {
		return
	}
	n.lastPrune = now
	for k, at := range n.seenAt {
		if now.Sub(at) > n.lifetime {
			delete(n.seenAt, k)
		}
	}
}

// parseTs reads a frame's millisecond timestamp.
func parseTs(raw json.RawMessage) (int64, bool) {
	ts, err := strconv.ParseInt(string(raw), 10, 64)
	return ts, err == nil
}

// tsInWindow reports whether a millisecond timestamp lies within ±inputMaxSkew of now.
func tsInWindow(ts int64) bool {
	skew := time.Since(time.UnixMilli(ts))
	return skew <= inputMaxSkew && skew >= -inputMaxSkew
}
