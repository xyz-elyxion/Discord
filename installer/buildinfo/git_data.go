package buildinfo

// Shown when git metadata (hash/tag) is genuinely unavailable at build time.
var VersionUnknown = "Unknown"

// Official installer release version; independent of git metadata.
var InstallerVersion = "1.0.0"

var InstallerGitHash = VersionUnknown
var InstallerTag = InstallerVersion
