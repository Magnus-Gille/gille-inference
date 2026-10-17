//go:build !linux

package activity

import "errors"

func StartConfigured(observerUID int64, effectiveConfig any) (func(), error) {
	if observerUID == -1 {
		return func() {}, nil
	}
	return nil, errors.New("private observer requires Linux")
}
