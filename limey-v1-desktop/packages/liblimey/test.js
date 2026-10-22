/**
 * @type {typeof import(".")}
 */
const libLimey V1 Desktop = require(".");
const test = require("node:test");
const assert = require("node:assert/strict");

test("getAccentColor should return a number", () => {
    const color = libLimey V1 Desktop.getAccentColor();
    assert.strictEqual(typeof color, "number");
});

test("updateUnityLauncherCount should return true (success)", () => {
    assert.strictEqual(libLimey V1 Desktop.updateUnityLauncherCount(5), true);
    assert.strictEqual(libLimey V1 Desktop.updateUnityLauncherCount(0), true);
    assert.strictEqual(libLimey V1 Desktop.updateUnityLauncherCount(10), true);
});

test("requestBackground should return true (success)", () => {
    assert.strictEqual(libLimey V1 Desktop.requestBackground(true, ["bash"]), true);
    assert.strictEqual(libLimey V1 Desktop.requestBackground(false, []), true);
});
