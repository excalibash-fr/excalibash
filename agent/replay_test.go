package main

import (
	"encoding/json"
	"fmt"
	"strconv"
	"testing"
	"time"
)

func TestNonceSetClaimSeen(t *testing.T) {
	n := newNonceSet(8)
	if n.seen("a") {
		t.Fatal("empty set reports a as seen")
	}
	if !n.claim("a") {
		t.Fatal("first claim of a refused")
	}
	if !n.seen("a") {
		t.Fatal("claimed id not seen")
	}
	if n.claim("a") {
		t.Fatal("replayed claim of a accepted")
	}
	if n.seen("b") || !n.claim("b") {
		t.Fatal("distinct id b refused")
	}
}

func TestNonceSetSeenDoesNotRecord(t *testing.T) {
	n := newNonceSet(8)
	n.seen("a")
	if !n.claim("a") {
		t.Fatal("a pre-check recorded the id")
	}
}

func TestNonceSetExpiry(t *testing.T) {
	n := newNonceSet(8)
	n.claim("old")
	// Age the entry past its lifetime and allow the next call to prune.
	n.mu.Lock()
	n.seenAt["old"] = time.Now().Add(-nonceLifetime - time.Second)
	n.lastPrune = time.Time{}
	n.mu.Unlock()
	if n.seen("old") {
		t.Fatal("expired id still seen")
	}
	if !n.claim("old") {
		t.Fatal("expired id not claimable again")
	}
}

func TestNonceSetPruneIsAmortised(t *testing.T) {
	n := newNonceSet(8)
	n.claim("x") // first call prunes and sets lastPrune
	n.mu.Lock()
	n.seenAt["x"] = time.Now().Add(-nonceLifetime - time.Second)
	n.mu.Unlock()
	// Within noncePruneEvery of the last scan, the expired entry is still held.
	if !n.seen("x") {
		t.Fatal("prune ran before noncePruneEvery elapsed")
	}
}

func TestNonceSetCap(t *testing.T) {
	const max = 4
	n := newNonceSet(max)
	for i := 0; i < max; i++ {
		if !n.claim(fmt.Sprint(i)) {
			t.Fatalf("claim %d refused below the cap", i)
		}
	}
	if n.claim("overflow") {
		t.Fatal("claim accepted on a full set")
	}
	if n.seen("overflow") {
		t.Fatal("refused claim was recorded")
	}
	// Once entries expire and a prune runs, room is made again.
	n.mu.Lock()
	for k := range n.seenAt {
		n.seenAt[k] = time.Now().Add(-nonceLifetime - time.Second)
	}
	n.lastPrune = time.Time{}
	n.mu.Unlock()
	if !n.claim("overflow") {
		t.Fatal("claim refused after expired entries were pruned")
	}
}

func TestParseTs(t *testing.T) {
	if ts, ok := parseTs(json.RawMessage("1700000000000")); !ok || ts != 1700000000000 {
		t.Fatalf("parseTs = %d, %v", ts, ok)
	}
	for _, bad := range []string{"", "abc", `"123"`, "1.5", "99999999999999999999"} {
		if _, ok := parseTs(json.RawMessage(bad)); ok {
			t.Fatalf("parseTs(%q) accepted", bad)
		}
	}
}

func TestTsInWindow(t *testing.T) {
	now := time.Now()
	margin := time.Minute
	cases := []struct {
		at   time.Time
		want bool
	}{
		{now, true},
		{now.Add(-inputMaxSkew + margin), true},
		{now.Add(inputMaxSkew - margin), true},
		{now.Add(-inputMaxSkew - margin), false},
		{now.Add(inputMaxSkew + margin), false},
	}
	for _, c := range cases {
		ts, _ := parseTs(json.RawMessage(strconv.FormatInt(c.at.UnixMilli(), 10)))
		if got := tsInWindow(ts); got != c.want {
			t.Errorf("tsInWindow(now%+v) = %v, want %v", c.at.Sub(now).Round(time.Second), got, c.want)
		}
	}
}
