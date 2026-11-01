# Builds the Limey V1 installer CLI. No third-party libraries: everything the
# Go version got from the standard library is either in the C++ standard
# library or delegated to the `curl` binary that ships with Windows, macOS
# and every mainstream Linux distribution (see src/http.cpp).
#
#   make                 build/LimeyV1Installer  (host binary)
#   make test            build and run the pure-logic + asar byte-layout tests
#   make windows         cross-build the Windows CLI with mingw-w64
#
# CI copies the resulting binary to ../dist/ under its release asset name.

CXX ?= g++
CXXFLAGS ?= -std=c++17 -O2 -Wall -Wextra
CPPFLAGS ?=
LDFLAGS ?=
BUILD := build
SOURCES := $(wildcard src/*.cpp)
OBJECTS := $(patsubst src/%.cpp,$(BUILD)/%.o,$(SOURCES))
BIN := $(BUILD)/LimeyV1Installer

# Shared objects the two test binaries need.
CORE := $(BUILD)/log.o $(BUILD)/util.o $(BUILD)/http.o $(BUILD)/paths.o

.PHONY: all clean test windows
all: $(BIN)

$(BIN): $(OBJECTS)
	$(CXX) $(CXXFLAGS) $(LDFLAGS) -o $@ $(OBJECTS)

$(BUILD)/%.o: src/%.cpp | $(BUILD)
	$(CXX) $(CPPFLAGS) $(CXXFLAGS) -c -o $@ $<

$(BUILD):
	mkdir -p $(BUILD)

$(BUILD)/asar-dump: tests/asar_dump.cpp $(BUILD)/asar.o $(CORE) | $(BUILD)
	$(CXX) $(CPPFLAGS) $(CXXFLAGS) -o $@ $^

$(BUILD)/logic-test: tests/logic_test.cpp $(BUILD)/downloader.o $(CORE) | $(BUILD)
	$(CXX) $(CPPFLAGS) $(CXXFLAGS) -o $@ $^

test: $(BUILD)/asar-dump $(BUILD)/logic-test
	./$(BUILD)/logic-test
	python3 tests/verify_asar.py ./$(BUILD)/asar-dump

# mingw-w64 ships as x86_64-w64-mingw32-g++ on the GitHub runner (apt install
# mingw-w64). The binary is static so it runs without a runtime DLL.
windows:
	mkdir -p $(BUILD)/win
	x86_64-w64-mingw32-g++ -std=c++17 -O2 -Wall -Wextra -static -pthread \
		-o $(BUILD)/LimeyV1Installer-cli-win.exe $(SOURCES)

clean:
	rm -rf $(BUILD)
