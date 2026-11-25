package main

// Watched pools (#lot 1): the pools HSI imported or the admin chose to watch.
// Their datasets join the volume guard. Kept in a file of HSI's own, which
// older releases ignore.

type watchedDataset struct {
	Name       string `json:"name"`
	MountPoint string `json:"mountPoint"`
}

type watchedPool struct {
	Name     string           `json:"name"`
	GUID     string           `json:"guid"`
	Datasets []watchedDataset `json:"datasets"`
}

var zfsPoolsPath = "/etc/hsi/zfs-pools.json"

func loadWatchedPools() []watchedPool {
	return []watchedPool{}
}
