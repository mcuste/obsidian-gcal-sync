import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_MAX_CHANGES_PER_SYNC } from "../src/gcal";
import {
  defaultSettings,
  parseSyncFolders,
  resolveTimeZone,
  systemTimeZone,
} from "../src/settings";

test("a new vault syncs everything under the default change limit", () => {
  const settings = defaultSettings("vault-id");

  assert.deepEqual(settings.syncFolders, []);
  assert.equal(settings.maxChangesPerSync, DEFAULT_MAX_CHANGES_PER_SYNC);
});

test("synced folders are trimmed to vault-relative paths and de-duplicated", () => {
  assert.deepEqual(parseSyncFolders("  Calendar  \n/Projects/Planning/\n\nCalendar\n   \n"), [
    "Calendar",
    "Projects/Planning",
  ]);
  assert.deepEqual(parseSyncFolders("   \n\n"), []);
});

test("an empty event time zone follows this device", () => {
  assert.equal(defaultSettings("vault-id").timeZone, "");
  assert.equal(resolveTimeZone(""), systemTimeZone());
  assert.equal(resolveTimeZone("Asia/Tokyo"), "Asia/Tokyo");
});
