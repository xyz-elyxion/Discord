// Pure-logic and end-to-end tests for the parts of the installer that do not
// need a real Discord install: hash stamp parsing, channel validation, URL
// routing, and a full download run against a file:// "backend" so the
// network path is exercised without touching the live site.

#include "../src/downloader.hpp"
#include "../src/log.hpp"
#include "../src/paths.hpp"
#include "../src/util.hpp"

#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <string>

#ifdef _WIN32
#include <process.h>
#define getpid _getpid
#else
#include <unistd.h>
#endif

namespace {

int g_failures = 0;

void check(bool condition, const std::string& message) {
    if (condition) {
        std::printf("ok - %s\n", message.c_str());
    } else {
        std::fprintf(stderr, "FAIL: %s\n", message.c_str());
        ++g_failures;
    }
}

void write(const std::string& path, const std::string& contents) {
    std::filesystem::create_directories(std::filesystem::path(path).parent_path());
    if (!util::write_file(path, contents)) {
        std::fprintf(stderr, "could not write %s\n", path.c_str());
        std::exit(1);
    }
}

} // namespace

int main() {
    using namespace downloader;

    // --- hash stamps -------------------------------------------------------
    check(parse_hash_line("// Limey abc123") == "abc123", "parses the JS hash stamp");
    check(parse_hash_line("/* Limey css9beef */") == "css9beef", "parses the CSS hash stamp");
    check(parse_hash_line("// Limey   spaced  ") == "spaced", "trims the hash");
    check(parse_hash_line("// unrelated comment") == "", "ignores unrelated comments");
    check(parse_hash_line("// Limey ") == "", "empty stamp has no hash");

    // --- channels ----------------------------------------------------------
    check(is_valid_channel("stable") && is_valid_channel("beta") && is_valid_channel("community"),
          "accepts implemented channels");
    check(!is_valid_channel("preview"), "rejects the UI-only preview alias");
    check(!is_valid_channel(""), "rejects an empty channel");
    check(channel_label("rc").find("Release Candidate") != std::string::npos,
          "labels the rc channel");

    // --- URL routing -------------------------------------------------------
    ReleaseChannel = "stable";
    check(file_url("patcher.js") == base_url() + "/v1/install/files/patcher.js",
          "stable channel serves the flat path");
    ReleaseChannel = "lts";
    check(file_url("patcher.js") == base_url() + "/v1/install/files/lts/patcher.js",
          "snapshot channels serve the nested path");
    ReleaseChannel = "stable";

    // --- end-to-end download over file:// ----------------------------------
    const std::filesystem::path tmp =
        std::filesystem::temp_directory_path() / ("limey-installer-test-" + std::to_string(::getpid()));
    std::filesystem::remove_all(tmp);

    const std::string remote = (tmp / "remote").string();
    const std::string files_dir = remote + "/v1/install/files";

    write(files_dir + "/renderer.css", "/* Limey deadbeef */\nbody{color:#9ccc3c}\n");
    write(files_dir + "/patcher.js", "// Limey deadbeef\nmodule.exports = 1;\n");
    write(files_dir + "/preload.js", "// Limey deadbeef\npreload\n");
    write(files_dir + "/renderer.js", "// Limey deadbeef\nrenderer\n");

    // LIMEY_INSTALLER_BASE_URL + file:// is how the downloader is pointed at a
    // local directory; curl handles file:// exactly like http.
    util::set_env("LIMEY_INSTALLER_BASE_URL", "file://" + remote);
    util::set_env("LIMEY_USER_DATA_DIR", (tmp / "data").string());

    paths::init();
    check(paths::FilesDirErr.empty(), "creates the installer data directory");

    init();
    check(wait_for_build_check(), "the build check reports success");
    check(LatestHash == "deadbeef", "reads the remote hash from renderer.css");

    std::string error = fetch_latest_builds();
    check(error.empty(), "downloads every build file: " + error);
    check(InstalledHash == "deadbeef", "records the installed hash after a successful download");
    check(util::read_file(paths::FilesDir + "/package.json") == "{}",
          "writes the empty package.json that stops node walking upwards");
    check(util::read_file(paths::FilesDir + "/patcher.js") == "// Limey deadbeef\nmodule.exports = 1;\n",
          "patcher.js contents survive the round trip");

    // --- channel marker ----------------------------------------------------
    check(read_installed_channel() == "stable", "defaults to stable without a marker");
    ReleaseChannel = "lts";
    check(write_channel_marker().empty(), "writes the channel marker");
    check(read_installed_channel() == "lts", "reads back the persisted channel");
    write(paths::FilesDir + "/channel.txt", "preview\n");
    check(read_installed_channel() == "stable", "falls back to stable for an invalid marker");
    ReleaseChannel = "stable";

    // --- failure paths -----------------------------------------------------
    write(files_dir + "/preload.js", "");
    error = fetch_latest_builds();
    check(error.find("empty file") != std::string::npos,
          "an empty download is an error, not a silent success: " + error);

    write(files_dir + "/preload.js", "// Limey deadbeef\npreload\n");
    ReleaseChannel = "no-such-channel";
    error = fetch_latest_builds();
    check(!error.empty(), "a channel the backend does not serve fails loudly: " + error);
    ReleaseChannel = "stable";

    IsDevInstall = true;
    check(fetch_latest_builds().empty(), "dev installs skip the download entirely");
    IsDevInstall = false;

    std::filesystem::remove_all(tmp);

    if (g_failures != 0) {
        std::fprintf(stderr, "%d check(s) failed\n", g_failures);
        return 1;
    }
    std::printf("all logic checks passed\n");
    return 0;
}
