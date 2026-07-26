import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const EXPECTED_PERMISSIONS = [
  "activeTab",
  "alarms",
  "notifications",
  "permissions",
  "scripting",
  "sidePanel",
  "storage",
];
const EXPECTED_HOST_PERMISSIONS = ["http://127.0.0.1:8765/*"];
const EXPECTED_OPTIONAL_HOST_PERMISSIONS = [
  "https://blog.naver.com/*",
  "https://m.blog.naver.com/*",
];

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Invalid extension build: ${message}`);
  }
}

async function requireFile(directory, relativePath) {
  assert(
    relativePath.length > 0 && !relativePath.startsWith("/") && !relativePath.includes(".."),
    `unsafe artifact path ${relativePath}`,
  );
  await access(resolve(directory, relativePath));
}

function sameValues(actual, expected) {
  return [...actual].sort().join("\n") === [...expected].sort().join("\n");
}

export async function validateDist(outputDirectory) {
  const manifestPath = resolve(outputDirectory, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert(manifest.manifest_version === 3, "manifest_version must be 3");
  assert(
    sameValues(manifest.permissions ?? [], EXPECTED_PERMISSIONS),
    "permissions must include only the required browser capabilities",
  );
  assert(
    sameValues(manifest.host_permissions ?? [], EXPECTED_HOST_PERMISSIONS),
    "only the loopback API host permission is allowed",
  );
  assert(
    sameValues(manifest.optional_host_permissions ?? [], EXPECTED_OPTIONAL_HOST_PERMISSIONS),
    "optional host permissions must include only the two Naver Blog origins",
  );
  assert(manifest.action?.default_popup === undefined, "default_popup must not be present");

  const backgroundPath = manifest.background?.service_worker;
  const sidePanelPath = manifest.side_panel?.default_path;
  assert(typeof backgroundPath === "string", "background service worker is required");
  assert(typeof sidePanelPath === "string", "side_panel.default_path is required");
  await requireFile(outputDirectory, backgroundPath);
  await requireFile(outputDirectory, sidePanelPath);

  const html = await readFile(resolve(outputDirectory, sidePanelPath), "utf8");
  assert(!/<script(?![^>]*\bsrc=)[^>]*>/iu.test(html), "inline scripts are forbidden");
  assert(!/\son[a-z]+\s*=/iu.test(html), "inline event handlers are forbidden");

  const referencedAssets = [
    ...html.matchAll(/<(?:script|link)\b[^>]*(?:src|href)=["']([^"']+)["'][^>]*>/giu),
  ].map((match) => match[1]);
  assert(referencedAssets.length > 0, "Side Panel must reference local assets");
  for (const asset of referencedAssets) {
    assert(!/^https?:/iu.test(asset), `remote asset ${asset} is forbidden`);
    await requireFile(outputDirectory, asset);
  }

  const forbiddenArtifacts = ["popup.html", "popup.js"];
  for (const artifact of forbiddenArtifacts) {
    try {
      await access(resolve(outputDirectory, artifact));
      throw new Error(`Invalid extension build: stale ${artifact} is present`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Invalid extension build:")) {
        throw error;
      }
    }
  }
}
