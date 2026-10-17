package activity

import (
	"errors"
	"sync"
)

const (
	defaultMaxLiveHandles uint64 = 4096
	defaultMaxSequence    uint64 = 9007199254740991
)

// Stage is the lifecycle state of tracked work.
type Stage string

const (
	Queued  Stage = "queued"
	Active  Stage = "active"
	Loading Stage = "loading"
)

// Snapshot is a point-in-time view of activity. A nil field means that
// accounting became unknown and must not be used for routing decisions.
type Snapshot struct {
	Active      *uint64 `json:"active"`
	Queued      *uint64 `json:"queued"`
	Loading     *uint64 `json:"loading"`
	WorkStarted *uint64 `json:"workStarted"`
}

type record struct {
	owner *Tracker
	stage Stage
	live  bool
}

// Handle identifies one live record in a Tracker.
type Handle struct {
	tracker *Tracker
	record  *record
}

// Tracker maintains bounded activity counts. Its zero value is not a usable
// tracker; use New so the caps and record table are initialized.
type Tracker struct {
	mu sync.Mutex

	maxLive     uint64
	maxSequence uint64
	records     map[*record]struct{}
	active      uint64
	queued      uint64
	loading     uint64
	workStarted uint64
	unknown     bool
}

// New returns an initialized activity tracker with the production caps.
func New() *Tracker {
	return newTracker(defaultMaxLiveHandles, defaultMaxSequence)
}

func newTracker(maxLive, maxSequence uint64) *Tracker {
	return &Tracker{
		maxLive:     maxLive,
		maxSequence: maxSequence,
		records:     make(map[*record]struct{}),
	}
}

// newWithCaps is intentionally unexported so tests can exercise boundary
// behavior without changing the production limits.
func newWithCaps(maxLive, maxSequence uint64) (*Tracker, error) {
	if maxLive == 0 || maxLive > defaultMaxLiveHandles {
		return nil, errors.New("invalid live-handle cap")
	}
	if maxSequence == 0 || maxSequence > defaultMaxSequence {
		return nil, errors.New("invalid sequence cap")
	}
	return newTracker(maxLive, maxSequence), nil
}

// Begin starts tracking work in stage. Accounting faults return nil and latch
// the tracker unknown; callers may continue their underlying work.
func (t *Tracker) Begin(stage Stage) *Handle {
	if t == nil {
		return nil
	}

	t.mu.Lock()
	defer t.mu.Unlock()
	if t.unknown {
		return nil
	}
	if !t.configValidLocked() {
		t.latchLocked()
		return nil
	}
	if !validStage(stage) || uint64(len(t.records)) >= t.maxLive || t.workStarted >= t.maxSequence {
		t.latchLocked()
		return nil
	}

	// Count the start before publishing the successful handle.
	t.workStarted++
	rec := &record{owner: t, stage: stage, live: true}
	t.records[rec] = struct{}{}
	t.addLocked(stage)
	if !t.validLocked() {
		t.latchLocked()
		return nil
	}
	return &Handle{tracker: t, record: rec}
}

// Transition moves this handle to a new stage. Nil handles are inert. Invalid,
// stale, or foreign handles latch their owning tracker unknown.
func (h *Handle) Transition(stage Stage) {
	if h == nil || h.tracker == nil || h.record == nil {
		return
	}
	t := h.tracker
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.unknown {
		return
	}
	if !t.configValidLocked() {
		t.latchLocked()
		return
	}
	if h.record.owner != t || !h.record.live {
		t.latchLocked()
		return
	}
	if !validStage(stage) {
		t.latchLocked()
		return
	}
	if stage != h.record.stage {
		if !t.removeLocked(h.record.stage) {
			t.latchLocked()
			return
		}
		t.addLocked(stage)
		h.record.stage = stage
	}
	if !t.validLocked() {
		t.latchLocked()
	}
}

// Finish removes this handle from live activity. Nil handles are inert. A
// duplicate, stale, or foreign finish latches its owning tracker unknown.
func (h *Handle) Finish() {
	if h == nil || h.tracker == nil || h.record == nil {
		return
	}
	t := h.tracker
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.unknown {
		return
	}
	if !t.configValidLocked() {
		t.latchLocked()
		return
	}
	if h.record.owner != t || !h.record.live {
		t.latchLocked()
		return
	}
	if _, ok := t.records[h.record]; !ok {
		t.latchLocked()
		return
	}
	delete(t.records, h.record)
	h.record.live = false
	if !t.removeLocked(h.record.stage) || !t.validLocked() {
		t.latchLocked()
	}
}

// Snapshot returns independent values that do not alias tracker state.
func (t *Tracker) Snapshot() Snapshot {
	if t == nil {
		return Snapshot{}
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.unknown {
		return Snapshot{}
	}
	if !t.configValidLocked() || !t.validLocked() {
		t.latchLocked()
		return Snapshot{}
	}
	active, queued, loading, workStarted := t.active, t.queued, t.loading, t.workStarted
	return Snapshot{
		Active:      &active,
		Queued:      &queued,
		Loading:     &loading,
		WorkStarted: &workStarted,
	}
}

func validStage(stage Stage) bool {
	switch stage {
	case Queued, Active, Loading:
		return true
	default:
		return false
	}
}

func (t *Tracker) addLocked(stage Stage) {
	switch stage {
	case Queued:
		t.queued++
	case Active:
		t.active++
	case Loading:
		t.loading++
	}
}

func (t *Tracker) removeLocked(stage Stage) bool {
	switch stage {
	case Queued:
		if t.queued == 0 {
			return false
		}
		t.queued--
	case Active:
		if t.active == 0 {
			return false
		}
		t.active--
	case Loading:
		if t.loading == 0 {
			return false
		}
		t.loading--
	default:
		return false
	}
	return true
}

func (t *Tracker) validLocked() bool {
	if !t.configValidLocked() {
		return false
	}
	if t.workStarted > t.maxSequence || t.workStarted > defaultMaxSequence {
		return false
	}
	if t.active > t.maxLive || t.queued > t.maxLive || t.loading > t.maxLive {
		return false
	}
	if t.active+t.queued+t.loading != uint64(len(t.records)) {
		return false
	}
	for rec := range t.records {
		if rec == nil || rec.owner != t || !rec.live || !validStage(rec.stage) {
			return false
		}
	}
	return true
}

func (t *Tracker) configValidLocked() bool {
	return t.maxLive > 0 && t.maxLive <= defaultMaxLiveHandles &&
		t.maxSequence > 0 && t.maxSequence <= defaultMaxSequence && t.records != nil
}

func (t *Tracker) latchLocked() {
	t.unknown = true
	t.records = make(map[*record]struct{})
	t.active, t.queued, t.loading = 0, 0, 0
}
