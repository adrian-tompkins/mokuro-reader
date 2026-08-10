import { db } from '$lib/catalog/db';
import type { VolumeData, VolumeMetadata } from '$lib/types';
import { liveQuery } from 'dexie';
import { derived, readable, type Readable } from 'svelte/store';
import { deriveSeriesFromVolumes } from '$lib/catalog/catalog';
import { unifiedCloudManager } from '$lib/util/sync/unified-cloud-manager';
import { generatePlaceholders } from '$lib/catalog/placeholders';
import { routeParams } from '$lib/util/hash-router';
import { getLegacyImageOnlyVolumeUuid } from '$lib/util/download-volume-repair';
import type { CloudFileMetadata } from '$lib/util/sync/provider-interface';

const AI_REFRESH_INTERVAL_MS = 15_000;
const AI_DOWNLOAD_ATTEMPTS = 3;
const discoveredAiFiles = new Map<string, CloudFileMetadata>();
const downloadedAiVersions = new Map<string, string>();

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function downloadAiSidecar(
  provider: NonNullable<ReturnType<typeof unifiedCloudManager.getActiveProvider>>,
  remoteAi: ReturnType<typeof unifiedCloudManager.getAllCloudVolumes>[number],
  volume: VolumeMetadata,
  existingAi: import('$lib/types').VolumeAI | undefined
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= AI_DOWNLOAD_ATTEMPTS; attempt += 1) {
    try {
      const parsed = JSON.parse(
        await (await provider.downloadFile(remoteAi)).text()
      ) as import('$lib/types').VolumeAI;
      if (parsed.schema_version !== 1 || !Array.isArray(parsed.pages)) {
        throw new Error('Invalid AI sidecar structure');
      }
      const canonicalAi = { ...parsed, volume_uuid: volume.volume_uuid };
      if (
        !existingAi ||
        (canonicalAi.updated_at > existingAi.updated_at &&
          canonicalAi.pages.length >= existingAi.pages.length)
      ) {
        await db.volume_ai.put(canonicalAi);
      }
      return;
    } catch (error) {
      lastError = error;
      if (attempt < AI_DOWNLOAD_ATTEMPTS) await delay(500 * attempt);
    }
  }
  throw lastError;
}

async function loadCurrentVolumeData(
  volume: VolumeMetadata,
  pollAi = false
): Promise<VolumeData | undefined> {
  const provider = unifiedCloudManager.getActiveProvider();
  if (provider) {
    const cloudPath = volume.cloudPath || `${volume.series_title}/${volume.volume_title}.cbz`;
    const aiPath = cloudPath.replace(/\.(cbz|zip|cbr|rar|7z)$/i, '.mokuro-ai.json').toLowerCase();
    const discoveryKey = `${provider.type}:${aiPath}`;
    let remoteAi: CloudFileMetadata | undefined;
    if (pollAi) {
      remoteAi = (await provider.listCloudVolumes()).find(
        (file) => file.path.toLowerCase() === aiPath
      );
      if (remoteAi) discoveredAiFiles.set(discoveryKey, remoteAi);
    } else {
      remoteAi =
        unifiedCloudManager
          .getAllCloudVolumes()
          .find((file) => file.path.toLowerCase() === aiPath) ||
        discoveredAiFiles.get(discoveryKey);
    }
    if (remoteAi) {
      const existingAi = await db.volume_ai.get(volume.volume_uuid);
      const remoteVersion = `${remoteAi.fileId}:${remoteAi.modifiedTime || ''}:${remoteAi.size || ''}`;
      if (!existingAi || downloadedAiVersions.get(discoveryKey) !== remoteVersion) {
        try {
          await downloadAiSidecar(provider, remoteAi, volume, existingAi);
          downloadedAiVersions.set(discoveryKey, remoteVersion);
        } catch (error) {
          console.warn(
            `Failed to refresh AI sidecar after ${AI_DOWNLOAD_ATTEMPTS} attempts:`,
            error
          );
        }
      }
    }
  }
  let [ocr, files, ai] = await Promise.all([
    db.volume_ocr.get(volume.volume_uuid),
    db.volume_files.get(volume.volume_uuid),
    db.volume_ai.get(volume.volume_uuid)
  ]);

  if (!ocr || !files) {
    const legacyUuid = getLegacyImageOnlyVolumeUuid(volume);
    if (legacyUuid) {
      const [legacyMetadata, legacyOcr, legacyFiles] = await Promise.all([
        db.volumes.get(legacyUuid),
        db.volume_ocr.get(legacyUuid),
        db.volume_files.get(legacyUuid)
      ]);

      // Repair legacy cloud image-only downloads that stored OCR/files under the
      // old deterministic UUID instead of the canonical placeholder UUID.
      if (!legacyMetadata && (legacyOcr || legacyFiles)) {
        await db.transaction('rw', [db.volume_ocr, db.volume_files], async () => {
          if (!ocr && legacyOcr) {
            ocr = { ...legacyOcr, volume_uuid: volume.volume_uuid };
            await db.volume_ocr.put(ocr);
            await db.volume_ocr.delete(legacyUuid);
          }

          if (!files && legacyFiles) {
            files = { ...legacyFiles, volume_uuid: volume.volume_uuid };
            await db.volume_files.put(files);
            await db.volume_files.delete(legacyUuid);
          }
        });
      }
    }
  }

  if (!ocr) {
    return undefined;
  }

  return {
    volume_uuid: volume.volume_uuid,
    pages: ocr.pages,
    files: files?.files,
    ai
  };
}

// Single source of truth from the database
export const volumes = readable<Record<string, VolumeMetadata>>({}, (set) => {
  const subscription = liveQuery(async () => {
    const volumesArray = await db.volumes.toArray();

    return volumesArray.reduce(
      (acc, vol) => {
        acc[vol.volume_uuid] = vol;
        return acc;
      },
      {} as Record<string, VolumeMetadata>
    );
  }).subscribe({
    next: (value) => set(value),
    error: (err) => console.error(err)
  });

  return () => subscription.unsubscribe();
});

// Merge local volumes with cloud placeholders
export const volumesWithPlaceholders = derived(
  [volumes, unifiedCloudManager.cloudFiles],
  ([$volumes, $cloudFiles]) => {
    const combined = { ...$volumes };
    const localVolumes = Object.values($volumes);

    // Generate cloud provider placeholders
    if ($cloudFiles.size > 0) {
      const cloudPlaceholders = generatePlaceholders($cloudFiles, localVolumes);
      for (const placeholder of cloudPlaceholders) {
        combined[placeholder.volume_uuid] = placeholder;
      }
    }

    return combined;
  },
  {} as Record<string, VolumeMetadata>
);

// Each derived store needs to be passed as an array if using multiple inputs
export const catalog = derived([volumesWithPlaceholders], ([$volumesWithPlaceholders]) => {
  // Return null while loading (before first data emission)
  if ($volumesWithPlaceholders === undefined) {
    return null;
  }
  return deriveSeriesFromVolumes(Object.values($volumesWithPlaceholders));
});

export const currentSeries = derived([routeParams, catalog], ([$routeParams, $catalog]) => {
  if (!$catalog || !$routeParams.manga) return [];

  const routeKey = $routeParams.manga.trim().replace(/\s+/g, ' ').toLowerCase();
  // Primary: match by title (folder name) - handles placeholder→local transition
  let series = $catalog.find((s) => s.title.trim().replace(/\s+/g, ' ').toLowerCase() === routeKey);

  // Fallback: match by UUID (for legacy URLs)
  if (!series) {
    series = $catalog.find((s) => s.series_uuid === $routeParams.manga);
  }

  return series?.volumes || [];
});

export const currentVolume = derived([routeParams, volumes], ([$routeParams, $volumes]) => {
  if ($routeParams && $volumes && $routeParams.volume) {
    return $volumes[$routeParams.volume]; // Direct lookup instead of find()
  }
  return undefined;
});

export const currentVolumeData: Readable<VolumeData | undefined> = derived(
  [currentVolume, unifiedCloudManager.cloudFiles],
  ([$currentVolume], set: (value: VolumeData | undefined) => void) => {
    let cancelled = false;
    let refreshTimer: ReturnType<typeof setInterval> | undefined;
    // Track the last volume UUID to avoid unnecessary clears
    // This prevents flash when unrelated volumes are added to the database
    const newUuid = $currentVolume?.volume_uuid;

    // Only clear data when actually navigating to a different volume
    // Don't clear if the store just emitted a new object reference for the same volume
    if (newUuid !== currentVolumeDataLastUuid) {
      currentVolumeDataLastUuid = newUuid;
      currentVolumeDataLastVersion = undefined;
      // Clear old data synchronously to prevent state leaks between volumes
      set(undefined);
    }

    if ($currentVolume) {
      const refresh = async (pollAi = false) => {
        try {
          const volumeData = await loadCurrentVolumeData($currentVolume, pollAi);
          if (!cancelled && volumeData) {
            const version = `${volumeData.volume_uuid}:${volumeData.ai?.updated_at || 0}:${volumeData.ai?.pages.length || 0}`;
            if (version !== currentVolumeDataLastVersion) {
              currentVolumeDataLastVersion = version;
              set(volumeData);
            }
          }
        } catch (error) {
          console.error('Failed to load current volume data:', error);
        }
      };
      void refresh();
      refreshTimer = setInterval(() => void refresh(true), AI_REFRESH_INTERVAL_MS);
    }

    return () => {
      cancelled = true;
      if (refreshTimer) clearInterval(refreshTimer);
    };
  },
  undefined // Initial value
);

// Track last volume UUID to prevent unnecessary data clears
let currentVolumeDataLastUuid: string | undefined;
let currentVolumeDataLastVersion: string | undefined;

/**
 * Japanese character count for current volume.
 * Uses page_char_counts from metadata for O(1) lookup when available.
 */
export const currentVolumeCharacterCount = derived(
  [currentVolume, currentVolumeData],
  ([$currentVolume, $currentVolumeData]) => {
    if (!$currentVolume) return 0;

    // Use pre-calculated cumulative char counts from metadata (v3)
    if ($currentVolume.page_char_counts && $currentVolume.page_char_counts.length > 0) {
      // Last element of cumulative array is the total
      return $currentVolume.page_char_counts[$currentVolume.page_char_counts.length - 1];
    }

    // Fallback: calculate from pages if page_char_counts not available
    if ($currentVolumeData && $currentVolumeData.pages) {
      const japaneseRegex =
        /[○◯々-〇〻ぁ-ゖゝ-ゞァ-ヺー\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u;

      let totalChars = 0;
      for (const page of $currentVolumeData.pages) {
        for (const block of page.blocks) {
          for (const line of block.lines) {
            totalChars += Array.from(line).filter((char) => japaneseRegex.test(char)).length;
          }
        }
      }
      return totalChars;
    }

    return 0;
  }
);
