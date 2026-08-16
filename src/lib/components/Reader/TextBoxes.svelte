<script lang="ts">
  import { clamp, promptConfirmation } from '$lib/util';
  import type { AIBlock, AIPage, AIRubySegment, Page } from '$lib/types';
  import { settings, volumes } from '$lib/settings';
  import {
    showCropper,
    openCreateModal,
    openUpdateModal,
    expandTextBoxBounds,
    sendQuickCapture,
    getLastCardInfo,
    getCardAgeInMin,
    extractFieldValues,
    getModelConfig,
    blobToBase64,
    type VolumeMetadata
  } from '$lib/anki-connect';
  import { db } from '$lib/catalog/db';
  import { layoutLines, getDefaultMeasurer, type LineLayout } from '$lib/reader/line-coords-layout';
  import { dedupeBlocks } from '$lib/reader/block-dedupe';

  interface ContextMenuData {
    x: number;
    y: number;
    lines: string[];
    imgElement: HTMLElement | null;
    textBox?: [number, number, number, number]; // [xmin, ymin, xmax, ymax] for initial crop
    pageIndex?: number;
  }

  interface Props {
    page: Page;
    src?: File;
    volumeUuid: string;
    /** 0-based page index within the volume */
    pageIndex?: number;
    aiPage?: AIPage;
    /** Force text visibility (for placeholder/missing pages) */
    forceVisible?: boolean;
    /** Callback when context menu should be shown */
    onContextMenu?: (data: ContextMenuData) => void;
  }

  let {
    page,
    src,
    volumeUuid,
    pageIndex,
    aiPage,
    forceVisible = false,
    onContextMenu
  }: Props = $props();

  interface TextBoxData {
    left: string;
    top: string;
    width: string;
    height: string;
    fontSize: string;
    writingMode: string;
    lines: string[];
    rubyLines: AIRubySegment[][] | null;
    area: number;
    useMinDimensions: boolean;
    isOriginalMode: boolean;
    /** Per-line positions/sizes from lines_coords (auto mode only);
     * null falls back to legacy hover-fit auto rendering */
    lineLayouts: LineLayout[] | null;
    blockIndex: number; // Original index in page.blocks
    ai?: AIBlock;
  }

  let textBoxes = $derived(
    dedupeBlocks(page.blocks)
      .map(({ block, blockIndex }) => {
        const { img_height, img_width } = page;
        const { box, font_size, lines, vertical } = block;
        const ai = aiPage?.blocks.find((item) => item.block_index === blockIndex);

        let [_xmin, _ymin, _xmax, _ymax] = box;

        // Replace manual ellipsis with proper ellipsis character (…)
        // Handle both ASCII periods (...) and full-width periods (．．．)
        const correctedLines =
          ai?.corrected_lines.length === lines.length ? ai.corrected_lines : lines;
        const processedLines = correctedLines.map((line) =>
          line.replace(/\.\.\./g, '…').replace(/．．．/g, '…')
        );
        const rubyLines =
          ai?.ruby_lines?.length === processedLines.length &&
          ai.ruby_lines.every(
            (rubyLine, lineIndex) =>
              rubyLine.map((segment) => segment.base).join('') === correctedLines[lineIndex]
          )
            ? ai.ruby_lines
            : null;

        const isOriginalMode = $settings.fontSize === 'original';
        const isAutoMode = $settings.fontSize === 'auto';

        // Auto mode: derive per-line position/size from the OCR line quads.
        // mokuro's block font_size overstates the true character size (it is
        // the quad width, furigana included), so rendering it as-is overflows
        // the box; the quads themselves are accurate. Null (no lines_coords,
        // e.g. pre-lines_coords imports) → legacy hover-fit auto below.
        const lineLayouts = isAutoMode
          ? layoutLines(block, processedLines, getDefaultMeasurer())
          : null;

        // Only expand bounding boxes for legacy hover-fit auto sizing;
        // per-line layout and manual font sizes use exact OCR bounding boxes
        let xmin, ymin, xmax, ymax;

        if (isAutoMode && !lineLayouts) {
          // Expand bounding box by 10% (5% on each side) to give text more room
          const originalWidth = _xmax - _xmin;
          const originalHeight = _ymax - _ymin;
          const expansionX = originalWidth * 0.05;
          const expansionY = originalHeight * 0.05;

          xmin = clamp(_xmin - expansionX, 0, img_width);
          ymin = clamp(_ymin - expansionY, 0, img_height);
          xmax = clamp(_xmax + expansionX, 0, img_width);
          ymax = clamp(_ymax + expansionY, 0, img_height);
        } else {
          xmin = _xmin;
          ymin = _ymin;
          xmax = _xmax;
          ymax = _ymax;
        }

        const width = xmax - xmin;
        const height = ymax - ymin;
        const area = width * height;

        // Determine font size based on setting
        let fontSize: string;
        if ($settings.fontSize === 'auto' || $settings.fontSize === 'original') {
          fontSize = `${font_size}px`;
        } else {
          fontSize = `${$settings.fontSize}pt`;
        }

        const textBox: TextBoxData = {
          left: `${xmin}px`,
          top: `${ymin}px`,
          width: `${width}px`,
          height: `${height}px`,
          fontSize,
          writingMode: vertical ? 'vertical-rl' : 'horizontal-tb',
          lines: processedLines,
          rubyLines,
          area,
          useMinDimensions: $settings.fontSize !== 'auto' && !isOriginalMode,
          isOriginalMode,
          lineLayouts,
          blockIndex,
          ai
        };

        return textBox;
      })
      .sort(({ area: a }, { area: b }) => {
        return b - a;
      })
  );

  let fontWeight = $derived($settings.boldFont ? 'bold' : '400');
  let display = $derived($settings.displayOCR ? 'block' : 'none');
  let alwaysShowOCR = $derived($settings.alwaysShowOCR);
  let border = $derived($settings.textBoxBorders ? '1px solid red' : 'none');
  let contenteditable = $derived($settings.textEditable);

  // Double-tap trigger: enabled if triggerMethod is 'doubleTap' or 'both' (legacy)
  let doubleTapEnabled = $derived(
    $settings.ankiConnectSettings.triggerMethod === 'doubleTap' ||
      $settings.ankiConnectSettings.triggerMethod === 'both'
  );
  let ankiTags = $derived($settings.ankiConnectSettings.tags);
  let cardMode = $derived($settings.ankiConnectSettings.cardMode);
  let volumeMetadata = $derived<VolumeMetadata>({
    seriesTitle: $volumes[volumeUuid]?.series_title,
    volumeTitle: $volumes[volumeUuid]?.volume_title
  });

  // Load volume cover image from DB and add to metadata
  async function getMetadataWithCover(): Promise<VolumeMetadata> {
    try {
      const dbVolume = await db.volumes.get(volumeUuid);
      if (dbVolume?.thumbnail) {
        const coverImage = await blobToBase64(dbVolume.thumbnail);
        if (coverImage) {
          return { ...volumeMetadata, coverImage };
        }
      }
    } catch {
      // Fall through to return metadata without cover
    }
    return volumeMetadata;
  }

  // Track adjusted font sizes for each textbox
  let adjustedFontSizes = $state<Map<number, string>>(new Map());
  // Track which textboxes need word wrapping enabled
  let needsWrapping = $state<Set<number>>(new Set());
  // Track which textboxes have been processed
  let processedTextBoxes = $state<Set<number>>(new Set());

  // Calculate optimal font size for a textbox using binary search
  // Two-phase approach: scale up until overflow, then find the goldilocks size
  function calculateOptimalFontSize(element: HTMLDivElement, initialFontSize: string) {
    // Parse the initial font size to get numeric value
    const match = initialFontSize.match(/(\d+(?:\.\d+)?)(px|pt)/);
    if (!match) return null;

    const originalSize = parseFloat(match[1]);
    const unit = match[2];
    const minFontSize = 8; // Minimum font size in px
    const maxFontSize = 200; // Maximum font size to try when scaling up

    // Convert to px for consistent handling, rounding to integer
    // Integer font sizes ensure the binary search always makes progress
    let originalInPx = Math.round(unit === 'pt' ? originalSize * 1.333 : originalSize);

    // Guard against invalid font sizes that would cause infinite loops
    // (0, negative, NaN, or Infinity would break the binary search)
    if (!Number.isFinite(originalInPx) || originalInPx < minFontSize) {
      originalInPx = minFontSize;
    }

    // Check if content overflows at a given font size
    const isOverflowingAt = (size: number) => {
      element.style.fontSize = `${size}px`;
      return (
        element.scrollHeight > element.clientHeight || element.scrollWidth > element.clientWidth
      );
    };

    // Binary search to find the largest font size that fits
    // Searches between low (fits) and high (overflows or max)
    const findOptimalSize = () => {
      // Phase 1: Find upper bound by scaling up until overflow
      let low = minFontSize;
      let high = originalInPx;

      // If original fits, try scaling up to find the true max
      if (!isOverflowingAt(originalInPx)) {
        // Double until we overflow or hit max
        high = originalInPx;
        while (!isOverflowingAt(high) && high < maxFontSize) {
          low = high;
          high = Math.min(high * 2, maxFontSize);
        }
        // If we're at max and still not overflowing, use max
        if (!isOverflowingAt(high)) {
          return high;
        }
      } else {
        // Original overflows, check if min fits
        if (isOverflowingAt(minFontSize)) {
          return minFontSize;
        }
        low = minFontSize;
        high = originalInPx;
      }

      // Phase 2: Binary search between low (fits) and high (overflows)
      while (high - low > 1) {
        const mid = Math.floor((low + high) / 2);
        if (isOverflowingAt(mid)) {
          high = mid;
        } else {
          low = mid;
        }
      }

      return low;
    };

    // Step 1: Find optimal size without wrapping
    element.style.whiteSpace = 'nowrap';
    element.style.wordWrap = 'normal';
    element.style.overflowWrap = 'normal';
    const noWrapSize = findOptimalSize();

    // Step 2: Only try wrapping if it could give us 1.3x the font size
    // Quick check: would 1.3x the noWrapSize overflow with wrapping?
    element.style.whiteSpace = 'normal';
    element.style.wordWrap = 'break-word';
    element.style.overflowWrap = 'break-word';

    const thresholdSize = noWrapSize * 1.3;
    if (!isOverflowingAt(thresholdSize)) {
      // Wrapping allows at least 1.3x - search for the actual optimal wrap size
      const wrapSize = findOptimalSize();
      return {
        finalSize: wrapSize,
        useWrapping: true,
        originalInPx
      };
    }

    // Wrapping doesn't help enough, use nowrap
    return {
      finalSize: noWrapSize,
      useWrapping: false,
      originalInPx
    };
  }

  // Handle hover event to calculate resize on demand (only for auto font sizing)
  function handleTextBoxHover(element: HTMLDivElement, params: [number, string]) {
    const [index, initialFontSize] = params;

    const calculate = () => {
      // Skip if already processed, OCR is hidden, using manual font size, or
      // the box is laid out per-line from lines_coords (no fitting needed)
      if (
        processedTextBoxes.has(index) ||
        display !== 'block' ||
        $settings.fontSize !== 'auto' ||
        element.classList.contains('perLine')
      )
        return;

      // Mark as processed immediately to prevent duplicate calculations
      processedTextBoxes.add(index);

      // Use requestAnimationFrame to ensure the DOM is fully rendered
      requestAnimationFrame(() => {
        const result = calculateOptimalFontSize(element, initialFontSize);
        if (!result) return;

        const { finalSize, useWrapping, originalInPx } = result;

        // Apply final settings
        if (useWrapping) {
          needsWrapping.add(index);
          element.style.whiteSpace = 'normal';
          element.style.wordWrap = 'break-word';
          element.style.overflowWrap = 'break-word';
        } else {
          element.style.whiteSpace = 'nowrap';
          element.style.wordWrap = 'normal';
          element.style.overflowWrap = 'normal';
        }

        element.style.fontSize = `${finalSize}px`;

        // Store adjusted size if it changed
        if (finalSize < originalInPx) {
          adjustedFontSizes.set(index, `${finalSize}px`);
        }
      });
    };

    element.addEventListener('mouseenter', calculate);
    // touchstart fires before long-press reveals the text box
    element.addEventListener('touchstart', calculate, { passive: true });

    return {
      destroy() {
        element.removeEventListener('mouseenter', calculate);
        element.removeEventListener('touchstart', calculate);
      }
    };
  }

  // Auto (per-line) mode: each line renders as an inline-block kept in normal
  // flow, so DOM text scanners (Yomitan/Migaku) read the whole block as one
  // continuous run — a per-line `position: absolute` would inject a hard break
  // at every line and split words/sentences across lines (issue #254). We then
  // translate each line onto its lines_coords quad. Measurement is required:
  // an inline element's natural flow position is only knowable after layout.
  //
  // offsetLeft/offsetTop are measured against the .textBox (the span's
  // offsetParent, since the box is position:absolute) and are in image px —
  // zoom is applied as an ancestor transform, so this coordinate space is
  // zoom-invariant. Both offsetLeft and the target `left` reference the box's
  // padding edge, so `target - offsetLeft` is the exact translate.
  function positionPerLine(container: HTMLDivElement, _signature: string) {
    let raf = 0;

    const apply = () => {
      const spans = container.querySelectorAll<HTMLElement>('.positionedLine');
      if (spans.length === 0) return;
      // display:none box (OCR hidden) → no offsetParent; measurement would read
      // 0. Skip and re-run on reveal (mouseenter/touchstart) or update.
      if (spans[0].offsetParent === null) return;

      // Read every natural origin first (one layout), then write every
      // transform (compositor-only, no reflow) — avoids layout thrash.
      const naturals: Array<[number, number]> = [];
      for (const span of spans) naturals.push([span.offsetLeft, span.offsetTop]);

      spans.forEach((span, i) => {
        const targetLeft = Number(span.dataset.targetLeft);
        const targetTop = Number(span.dataset.targetTop);
        if (!Number.isFinite(targetLeft) || !Number.isFinite(targetTop)) return;
        span.style.transform = `translate(${targetLeft - naturals[i][0]}px, ${targetTop - naturals[i][1]}px)`;
      });
    };

    const schedule = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(apply);
    };

    schedule();
    // Fonts change glyph advance → re-measure once the real font is ready.
    document.fonts?.ready?.then(schedule);
    // Box may have been display:none at mount; catch first reveal.
    container.addEventListener('mouseenter', schedule);
    container.addEventListener('touchstart', schedule, { passive: true });

    return {
      // _signature changes on displayOCR toggle or font-size setting change.
      update: schedule,
      destroy() {
        cancelAnimationFrame(raf);
        container.removeEventListener('mouseenter', schedule);
        container.removeEventListener('touchstart', schedule);
      }
    };
  }

  function getImageUrlFromElement(element: HTMLElement): string | null {
    // Traverse up to find the MangaPage div with background-image
    let current: HTMLElement | null = element;
    while (current) {
      const bgImage = getComputedStyle(current).backgroundImage;
      if (bgImage && bgImage !== 'none') {
        // Extract URL from "url(...)"
        const match = bgImage.match(/url\(["']?(.+?)["']?\)/);
        if (match) {
          return match[1];
        }
      }
      current = current.parentElement;
    }
    return null;
  }

  function getSelectedText(): string {
    // Get actual selected text from the DOM
    const selection = window.getSelection();
    return selection?.toString().trim() || '';
  }

  async function onUpdateCard(event: Event, lines: string[], blockIndex: number) {
    if (!$settings.ankiConnectSettings.enabled) return;

    const selectedText = getSelectedText();
    const fullSentence = lines.join(' ');

    // Get the original block's bounding box for initial crop
    const block = page.blocks[blockIndex];
    const textBox = block ? expandTextBoxBounds(block, page) : undefined;

    // Get image URL
    const url =
      getImageUrlFromElement(event.target as HTMLElement) ||
      (src ? URL.createObjectURL(src) : null);

    if (!url) return;

    // Get current page number for {page} template
    // Use the explicit pageIndex prop (0-based) when available, otherwise fall back to progress
    const pageNumber = pageIndex != null ? pageIndex + 1 : $volumes[volumeUuid]?.progress || 1;

    // Load cover image for {cover} template support
    const metadataWithCover = await getMetadataWithCover();

    if (cardMode === 'update') {
      // Update mode: fetch previous card values with retry
      const maxRetries = 3;
      let lastCard = null;
      let lastError = '';

      for (let attempt = 0; attempt < maxRetries; attempt++) {
        lastCard = await getLastCardInfo();

        if (!lastCard || !lastCard.noteId) {
          lastError = 'No recent card found to update';
          // Wait before retry (except on last attempt)
          if (attempt < maxRetries - 1) {
            await new Promise((r) => setTimeout(r, 500));
          }
          continue;
        }

        if (!lastCard.modelName) {
          lastError = 'Could not detect card note type';
          // Wait before retry
          if (attempt < maxRetries - 1) {
            await new Promise((r) => setTimeout(r, 500));
          }
          continue;
        }

        // Success - break out of retry loop
        lastError = '';
        break;
      }

      if (lastError || !lastCard?.noteId || !lastCard?.modelName) {
        const { showSnackbar } = await import('$lib/util');
        showSnackbar(`Error: ${lastError || 'Failed to fetch card info'}`);
        return;
      }

      const cardAge = getCardAgeInMin(lastCard.noteId);
      if (cardAge >= 5) {
        // Card too old
        const { showSnackbar } = await import('$lib/util');
        showSnackbar(`Last card is ${cardAge} minutes old (max 5 min)`);
        return;
      }

      const previousValues = extractFieldValues(lastCard);

      // Get the model config to check for quickCapture setting
      const modelConfig = getModelConfig(lastCard.modelName, 'update');
      const hasConfig = !!modelConfig;
      const quickCapture = modelConfig?.quickCapture ?? false;

      if (quickCapture) {
        // Quick capture: send directly without modal
        await sendQuickCapture(
          'update',
          url,
          selectedText || fullSentence,
          fullSentence,
          metadataWithCover,
          textBox,
          previousValues,
          lastCard.noteId,
          lastCard.tags,
          lastCard.modelName,
          page.img_path
        );
      } else {
        // Show modal in update mode - use the card's model name
        // (also shown if quickCapture but no config exists)
        openUpdateModal(
          url,
          previousValues,
          lastCard.noteId,
          lastCard.modelName,
          lastCard.tags, // existing tags from the card
          selectedText || fullSentence,
          fullSentence,
          ankiTags,
          metadataWithCover,
          undefined,
          textBox,
          pageNumber,
          page.img_path
        );
      }
    } else {
      // Create mode
      const { selectedModel } = $settings.ankiConnectSettings;
      const modelConfig = getModelConfig(selectedModel, 'create');
      const quickCapture = modelConfig?.quickCapture ?? false;

      if (quickCapture) {
        await sendQuickCapture(
          'create',
          url,
          selectedText || fullSentence,
          fullSentence,
          metadataWithCover,
          textBox,
          undefined, // previousValues
          undefined, // previousCardId
          undefined, // previousTags
          undefined, // modelName
          page.img_path
        );
      } else {
        // Show modal (also shown if quickCapture but no config exists)
        openCreateModal(
          url,
          selectedText || fullSentence,
          fullSentence,
          ankiTags,
          metadataWithCover,
          undefined,
          textBox,
          pageNumber,
          page.img_path
        );
      }
    }
  }

  function handleContextMenu(event: MouseEvent, lines: string[], blockIndex: number) {
    // Only show custom context menu if enabled in settings
    if (!$settings.textBoxContextMenu) return;

    event.preventDefault();

    // Get text box bounds with padding
    const block = page.blocks[blockIndex];
    const textBox = block ? expandTextBoxBounds(block, page) : undefined;

    onContextMenu?.({
      x: event.clientX,
      y: event.clientY,
      lines,
      imgElement: event.target as HTMLElement,
      textBox,
      pageIndex
    });
  }

  function onDoubleTap(event: Event, lines: string[], blockIndex: number) {
    // Always stop propagation to prevent zoom from triggering
    event.stopPropagation();
    if (doubleTapEnabled) {
      event.preventDefault();
      onUpdateCard(event, lines, blockIndex);
    }
  }

  function onCopy(event: ClipboardEvent) {
    // Strip line breaks from copied text (Ctrl+C default behavior)
    const selection = window.getSelection()?.toString() || '';
    const stripped = selection.replace(/[\n\r\t]/g, '');
    event.clipboardData?.setData('text/plain', stripped);
    event.preventDefault();
  }

  let openAiBlock = $state<number | null>(null);
  let openOcrBlock = $state<number | null>(null);
  let openAiWord = $state<number | null>(null);
  let mobileAiPanel = $state(false);
  let desktopPanelLeft = $state(12);
  let desktopPanelTop = $state<number | null>(null);
  let desktopPanelBottom = $state<number | null>(null);
  let draggingAiPanel = $state(false);
  let aiPanelDrag:
    | { pointerId: number; offsetX: number; offsetY: number; panel: HTMLElement }
    | undefined;

  function portalToBody(node: HTMLElement, enabled: boolean) {
    if (enabled) document.body.appendChild(node);

    return {
      update(nextEnabled: boolean) {
        if (nextEnabled && node.parentNode !== document.body) document.body.appendChild(node);
      },
      destroy() {
        if (enabled && node.parentNode === document.body) node.remove();
      }
    };
  }

  function showAi(event: MouseEvent, blockIndex: number) {
    event.stopPropagation();
    if (window.getSelection()?.toString()) return;
    mobileAiPanel = window.matchMedia?.('(hover: none), (pointer: coarse)').matches ?? false;

    // Touch has no persistent hover state. Use the first tap to reveal the OCR
    // and only open the AI panel when the same block is tapped again.
    if (mobileAiPanel && openOcrBlock !== blockIndex) {
      openOcrBlock = blockIndex;
      openAiBlock = null;
      openAiWord = null;
      return;
    }

    if (!mobileAiPanel) {
      const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
      const panelWidth = Math.min($settings.translationPanelMaxWidth, window.innerWidth - 24);
      desktopPanelLeft = Math.max(12, Math.min(box.left, window.innerWidth - panelWidth - 12));

      const spaceBelow = window.innerHeight - box.bottom;
      if (spaceBelow >= 260 || spaceBelow >= box.top) {
        desktopPanelTop = box.bottom + 12;
        desktopPanelBottom = null;
      } else {
        desktopPanelTop = null;
        desktopPanelBottom = window.innerHeight - box.top + 12;
      }
    }

    openAiBlock = blockIndex;
    openAiWord = null;
  }

  function closeAi(event: PointerEvent) {
    const target = event.target as Element | null;
    if (target?.closest('.textBox, .aiPanel')) return;
    openAiBlock = null;
    openOcrBlock = null;
    openAiWord = null;
  }

  function startAiPanelDrag(event: PointerEvent) {
    event.stopPropagation();
    if (mobileAiPanel || event.button !== 0) return;
    const target = event.target as Element | null;
    if (!target?.closest('.aiDragHandle')) return;

    const panel = event.currentTarget as HTMLElement;
    const rect = panel.getBoundingClientRect();
    desktopPanelLeft = rect.left;
    desktopPanelTop = rect.top;
    desktopPanelBottom = null;
    aiPanelDrag = {
      pointerId: event.pointerId,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      panel
    };
    draggingAiPanel = true;
    try {
      panel.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture can be unavailable in synthetic/test environments.
    }
    event.preventDefault();
  }

  function moveAiPanel(event: PointerEvent) {
    const drag = aiPanelDrag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.stopPropagation();
    const rect = drag.panel.getBoundingClientRect();
    const margin = 8;
    desktopPanelLeft = Math.max(
      margin,
      Math.min(event.clientX - drag.offsetX, window.innerWidth - rect.width - margin)
    );
    desktopPanelTop = Math.max(
      margin,
      Math.min(event.clientY - drag.offsetY, window.innerHeight - rect.height - margin)
    );
  }

  function endAiPanelDrag(event: PointerEvent) {
    const drag = aiPanelDrag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.stopPropagation();
    try {
      drag.panel.releasePointerCapture(event.pointerId);
    } catch {
      // It may already have been released by the browser.
    }
    aiPanelDrag = undefined;
    draggingAiPanel = false;
  }
</script>

<svelte:window onpointerdown={closeAi} />

{#each textBoxes as { fontSize, height, left, lines, rubyLines, top, width, writingMode, useMinDimensions, isOriginalMode, lineLayouts, blockIndex, ai }, index (`${volumeUuid}-textBox-${index}`)}
  {@const usePerLine = lineLayouts !== null}
  <div
    use:handleTextBoxHover={[index, fontSize]}
    use:positionPerLine={`${display}|${$settings.fontSize}`}
    class="textBox"
    class:originalMode={isOriginalMode}
    class:perLine={usePerLine}
    class:verticalText={writingMode === 'vertical-rl'}
    class:forceVisible
    class:alwaysVisible={alwaysShowOCR}
    class:tapVisible={openOcrBlock === blockIndex}
    class:hasAi={Boolean(ai)}
    style:width={usePerLine ? width : isOriginalMode || useMinDimensions ? undefined : width}
    style:height={usePerLine ? height : isOriginalMode || useMinDimensions ? undefined : height}
    style:min-width={isOriginalMode ? undefined : useMinDimensions ? width : undefined}
    style:min-height={isOriginalMode ? undefined : useMinDimensions ? height : undefined}
    style:left
    style:top
    style:font-size={adjustedFontSizes.get(index) || fontSize}
    style:font-weight={fontWeight}
    style:display
    style:border
    style:writing-mode={writingMode}
    role="none"
    oncontextmenu={(e) => handleContextMenu(e, lines, blockIndex)}
    ondblclick={(e) => onDoubleTap(e, lines, blockIndex)}
    onclick={(event) => {
      if (ai) showAi(event, blockIndex);
    }}
    oncopy={onCopy}
    {contenteditable}
  >
    <p>
      {#if usePerLine && lineLayouts}
        {#each lines as line, lineIndex}{#if !lineLayouts[lineIndex].hidden}<span
              class="ocr-line positionedLine"
              class:wrappedLine={lineLayouts[lineIndex].wrap}
              data-target-left={lineLayouts[lineIndex].left}
              data-target-top={lineLayouts[lineIndex].top}
              style:width={lineLayouts[lineIndex].wrap
                ? `${lineLayouts[lineIndex].width}px`
                : undefined}
              style:height={lineLayouts[lineIndex].wrap
                ? `${lineLayouts[lineIndex].height}px`
                : undefined}
              style:font-size={`${lineLayouts[lineIndex].fontSize}px`}
              >{#if rubyLines?.[lineIndex]}{#each rubyLines[lineIndex] as segment}{#if segment.reading}<ruby
                      >{segment.base}<rt>{segment.reading}</rt></ruby
                    >{:else}{segment.base}{/if}{/each}{:else}{line}{/if}</span
            >{/if}{/each}
      {:else}
        {#each lines as line, lineIndex}<span class="ocr-line"
            >{#if rubyLines?.[lineIndex]}{#each rubyLines[lineIndex] as segment}{#if segment.reading}<ruby
                    >{segment.base}<rt>{segment.reading}</rt></ruby
                  >{:else}{segment.base}{/if}{/each}{:else}{line}{/if}</span
          >{/each}
      {/if}
    </p>
    {#if ai}
      {#if openAiBlock === blockIndex}
        <div
          use:portalToBody={true}
          class="aiPanel"
          class:desktopViewportPanel={!mobileAiPanel}
          class:mobileViewportPanel={mobileAiPanel}
          class:dragging={draggingAiPanel}
          style:font-size={!mobileAiPanel ? `${$settings.translationPanelFontSize}px` : undefined}
          style:max-width={!mobileAiPanel
            ? `min(${$settings.translationPanelMaxWidth}px, calc(100vw - 24px))`
            : undefined}
          style:left={!mobileAiPanel ? `${desktopPanelLeft}px` : undefined}
          style:top={!mobileAiPanel && desktopPanelTop !== null
            ? `${desktopPanelTop}px`
            : undefined}
          style:bottom={!mobileAiPanel && desktopPanelBottom !== null
            ? `${desktopPanelBottom}px`
            : undefined}
          onpointerdown={startAiPanelDrag}
          onpointermove={moveAiPanel}
          onpointerup={endAiPanelDrag}
          onpointercancel={endAiPanelDrag}
        >
          <div class="aiHeading aiDragHandle">Translation</div>
          <div>{ai.translation}</div>
          {#if ai.corrected_lines.join('') !== ai.source_lines.join('')}
            <div class="aiHeading">OCR correction</div>
            <div lang="ja">{ai.corrected_lines.join('')}</div>
          {/if}
          {#if ai.words.length}
            <div class="aiHeading">Words</div>
            <div class="aiWords">
              {#each ai.words as word, wordIndex}
                <button
                  type="button"
                  lang="ja"
                  onclick={(event) => {
                    event.stopPropagation();
                    openAiWord = openAiWord === wordIndex ? null : wordIndex;
                  }}>{word.surface}</button
                >
              {/each}
              {#if openAiWord !== null && ai.words[openAiWord]}
                {@const selectedWord = ai.words[openAiWord]}
                <div class="aiWordDetail">
                  <strong>{selectedWord.surface}</strong>{selectedWord.reading &&
                  selectedWord.reading !== selectedWord.surface
                    ? ` (${selectedWord.reading})`
                    : ''}<br />
                  {#if selectedWord.dictionary_form && selectedWord.dictionary_form !== selectedWord.surface}{selectedWord.dictionary_form}{selectedWord.dictionary_reading
                      ? ` (${selectedWord.dictionary_reading})`
                      : ''}<br />{/if}
                  {selectedWord.meaning}{selectedWord.grammar ? ` · ${selectedWord.grammar}` : ''}
                </div>
              {/if}
            </div>
          {/if}
        </div>
      {/if}
    {/if}
  </div>
{/each}

<style>
  .textBox {
    color: black;
    padding: 0;
    position: absolute;
    line-height: 1.1em;
    font-size: 16pt;
    font-family: 'Noto Sans JP', sans-serif;
    /* Word wrapping controlled dynamically by JavaScript */
    border: 1px solid rgba(0, 0, 0, 0);
    z-index: 11;
    user-select: text;
    -webkit-user-select: text;
    -moz-user-select: text;
    -ms-user-select: text;
    -webkit-text-size-adjust: 100%;
    text-size-adjust: 100%;
    box-sizing: border-box;
  }

  .textBox:focus,
  .textBox:hover {
    background: rgb(255, 255, 255);
    border: 1px solid rgba(0, 0, 0, 0);
  }

  .textBox p {
    visibility: hidden;
    /* Word wrapping controlled dynamically by JavaScript */
    letter-spacing: 0.1em;
    line-height: 1.1em;
    background-color: rgb(255, 255, 255);
    font-weight: var(--bold);
    font-family: 'Noto Sans JP', sans-serif;
    z-index: 11;
    user-select: text;
    -webkit-user-select: text;
    -moz-user-select: text;
    -ms-user-select: text;
    -webkit-text-size-adjust: 100%;
    text-size-adjust: 100%;
  }

  .textBox:focus p,
  .textBox:hover p {
    visibility: visible;
  }

  /* Force visibility for placeholder/missing pages, or when always-show OCR is enabled */
  .textBox.forceVisible,
  .textBox.alwaysVisible,
  .textBox.tapVisible {
    background: rgb(255, 255, 255);
  }

  .textBox.forceVisible p,
  .textBox.alwaysVisible p,
  .textBox.tapVisible p {
    visibility: visible;
  }

  /* Original mode: no size constraints, allow overflow */
  .textBox.originalMode {
    overflow: visible;
    white-space: nowrap;
  }

  .textBox.originalMode p {
    white-space: nowrap;
  }

  /* Auto mode with lines_coords: each line is placed at its detected quad with
     a geometry-derived font size. The line stays inline-block IN NORMAL FLOW
     (not position:absolute) so DOM text scanners read the block as one
     continuous run (#254); a measurement action then translates it onto the
     quad. line-height 1 keeps the column/row no thicker than the font size;
     letter-spacing 0 because the print's tracking is already baked into the
     quad length the size was fitted to. */
  .textBox.perLine .ocr-line.positionedLine {
    display: inline-block;
    line-height: 1;
    letter-spacing: 0;
    white-space: nowrap;
    /* transform (translate onto the quad) is set by positionPerLine */
  }

  .textBox ruby {
    ruby-position: over;
    ruby-align: center;
    ruby-overhang: none;
  }

  .textBox rt {
    font-size: 0.42em;
    font-weight: 400;
    letter-spacing: 0;
  }

  /* In vertical-rl, `over` places ruby on the right of its base glyphs. Pull
     it slightly back toward that column so it stays out of the neighbouring
     column's full-size text without introducing a conspicuous gap. */
  .textBox.verticalText rt {
    position: relative;
    left: -0.12em;
  }

  /* A quad that captured multiple print columns (base text + furigana):
     the text flows inside the full quad bbox at the block's reference size,
     wrapping into columns/rows instead of shrinking onto one line. */
  .textBox.perLine .ocr-line.positionedLine.wrappedLine {
    white-space: normal;
    line-break: anywhere;
  }

  /* Legacy/manual modes: use a CSS-generated newline instead of <br/> so DOM
     walkers (Migaku/Yomitan) see one continuous text run per textbox and don't
     treat line breaks as sentence boundaries. Per-line (auto) mode positions
     each line explicitly and needs no visible newline; the generated content
     was never seen by Yomitan anyway. */
  .textBox:not(.perLine) .ocr-line:not(:last-child)::after {
    content: '\A';
    white-space: pre;
  }

  .textBox.hasAi {
    cursor: pointer;
  }
  .aiWords button {
    border: 1px solid #64748b;
    border-radius: 4px;
    background: #0f172a;
    color: white;
    padding: 3px 6px;
    font: inherit;
    line-height: 1.2;
    cursor: pointer;
    white-space: nowrap;
  }
  .aiPanel {
    width: min(40rem, 80vw);
    max-height: 60vh;
    overflow: auto;
    padding: 12px;
    border: 1px solid #64748b;
    border-radius: 8px;
    background: #fff;
    color: #111827;
    box-shadow: 0 8px 24px #0004;
    font:
      14px/1.45 system-ui,
      sans-serif;
    white-space: normal;
    writing-mode: horizontal-tb;
    z-index: 30;
  }
  .aiPanel.desktopViewportPanel {
    position: fixed;
    width: max-content;
    box-sizing: border-box;
    overflow-wrap: anywhere;
    z-index: 10000;
  }
  .desktopViewportPanel .aiDragHandle {
    cursor: grab;
    user-select: none;
  }
  .desktopViewportPanel.dragging .aiDragHandle {
    cursor: grabbing;
  }
  .aiHeading {
    margin-top: 10px;
    margin-bottom: 3px;
    color: #475569;
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
  }
  .aiHeading:first-child {
    margin-top: 0;
  }
  .aiWords {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
    align-items: flex-start;
  }
  .aiWordDetail {
    flex-basis: 100%;
    padding: 7px;
    border-radius: 4px;
    background: #f1f5f9;
  }

  .aiPanel.mobileViewportPanel {
    position: fixed;
    inset: 50% max(12px, env(safe-area-inset-right)) auto max(12px, env(safe-area-inset-left));
    width: auto;
    max-height: min(70dvh, 36rem);
    padding: 16px;
    border-radius: 12px;
    transform: translateY(-50%);
    font-size: 16px;
    z-index: 10000;
  }

  @media (hover: none), (pointer: coarse) {
    .textBox.hasAi {
      touch-action: manipulation;
    }

    .aiWords button {
      min-height: 36px;
      padding: 8px 10px;
      touch-action: manipulation;
    }
  }
</style>
