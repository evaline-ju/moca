package session

import "strings"

// TierLabelKey is the presence label the harness filters sandboxes on (P6.3 spec §3.1). The relay
// copies Hello.labels into the presence record unchanged, so this one key is the whole contract
// between a worker and selectPoolSandbox's tier filter.
const TierLabelKey = "moca.dev/tier"

// TierLabels returns the Hello labels for this worker's sandbox tier: SANDBOX_TIER when it is set,
// def when it is unset. Set but empty (or blank) means no label at all, deliberately unlike env()'s
// empty-means-default: an operator attaching a worker with no tier on purpose must not be overridden
// by the binary's default, and a tiered harness excludes an unlabelled worker loudly (spec §4 step 1).
func TierLabels(lookup func(string) (string, bool), def string) map[string]string {
	v, ok := lookup("SANDBOX_TIER")
	if !ok {
		v = def
	}
	v = strings.TrimSpace(v)
	if v == "" {
		return nil
	}
	return map[string]string{TierLabelKey: v}
}
