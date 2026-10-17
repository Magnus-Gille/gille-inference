//go:build linux

package activity

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
)

const observationSocket = "/run/llama-swap-observer/activity.sock"

// StartConfigured is opt-in service startup. It never creates directories,
// changes identities or takes a caller-selected path. The service manager must
// prepare the exact private runtime directory in a separately approved rollout.
func StartConfigured(observerUID int64, effectiveConfig any) (func(), error) {
	if observerUID == -1 {
		return func() {}, nil
	}
	if observerUID < 0 || observerUID > 4294967295 {
		return nil, errEndpoint
	}
	config, err := json.Marshal(effectiveConfig)
	if err != nil || len(config) > 1024*1024 {
		return nil, errEndpoint
	}
	configHash := sha256.Sum256(config)
	executable, err := os.Open("/proc/self/exe")
	if err != nil {
		return nil, errEndpoint
	}
	hash := sha256.New()
	size, err := io.Copy(hash, io.LimitReader(executable, 256*1024*1024+1))
	executable.Close()
	if err != nil || size == 0 || size > 256*1024*1024 {
		return nil, errEndpoint
	}
	var instance [32]byte
	if _, err := rand.Read(instance[:]); err != nil {
		return nil, errEndpoint
	}
	identity := Identity{ProducerID: "llama-swap", InstanceSHA256: hex.EncodeToString(instance[:]),
		BuildSHA256: hex.EncodeToString(hash.Sum(nil)), ConfigSHA256: hex.EncodeToString(configHash[:])}
	endpoint, err := Listen(observationSocket, uint32(observerUID), identity, Process())
	if err != nil {
		return nil, err
	}
	return func() { _ = endpoint.Close() }, nil
}
