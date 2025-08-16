<script lang="ts">
  import { clamp, promptConfirmation } from '$lib/util';
  import type { Page } from '$lib/types';
  import { settings } from '$lib/settings';
  import { imageToWebp, showCropper, updateLastCard } from '$lib/anki-connect';
  import { FileWordpressSolid } from 'flowbite-svelte-icons';

  export let page: Page;
  export let src: File;

  $: textBoxes = page.blocks
    .map((block) => {
      const { img_height, img_width } = page;
      const { box, font_size, lines, line_translations, translation, vertical } = block;

      let [_xmin, _ymin, _xmax, _ymax] = box;

      const xmin = clamp(_xmin, 0, img_width);
      const ymin = clamp(_ymin, 0, img_height);
      const xmax = clamp(_xmax, 0, img_width);
      const ymax = clamp(_ymax, 0, img_height);

      const width = xmax - xmin;
      const height = ymax - ymin;
      const area = width * height;

      const textBox = {
        left: `${xmin}px`,
        top: `${ymin}px`,
        width: `${width}px`,
        height: `${height}px`,
        fontSize: $settings.fontSize === 'auto' ? `${font_size}px` : `${$settings.fontSize}pt`,
        writingMode: vertical ? 'vertical-rl' : 'horizontal-tb',
        lines,
        line_translations,
        translation,
        area
      };

      return textBox;
    })
    .sort(({ area: a }, { area: b }) => {
      return b - a;
    });

  $: fontWeight = $settings.boldFont ? 'bold' : '400';
  $: display = $settings.displayOCR ? 'block' : 'none';
  $: border = $settings.textBoxBorders ? '1px solid red' : 'none';
  $: contenteditable = $settings.textEditable;

  $: triggerMethod = $settings.ankiConnectSettings.triggerMethod || 'both';

  async function onUpdateCard(lines: string[]) {
    if ($settings.ankiConnectSettings.enabled) {
      const sentence = lines.join(' ');
      if ($settings.ankiConnectSettings.cropImage) {
        showCropper(URL.createObjectURL(src), sentence);
      } else {
        promptConfirmation('Add image to last created anki card?', async () => {
          const imageData = await imageToWebp(src, $settings);
          updateLastCard(imageData, sentence);
        });
      }
    }
  }

  function onContextMenu(event: Event, lines: string[]) {
    if (triggerMethod === 'both' || triggerMethod === 'rightClick') {
      event.preventDefault();
      onUpdateCard(lines);
    }
  }

  function onDoubleTap(event: Event, lines: string[]) {
    if (triggerMethod === 'both' || triggerMethod === 'doubleTap') {
      event.preventDefault();
      onUpdateCard(lines);
    }
  }

  let openDetail: { box: number; line: number; word: number } | null = null;

  function toggleDetail(e: MouseEvent, boxIdx: number, lineIdx: number, wordIdx: number) {
    e.stopPropagation();
    const same =
      openDetail &&
      openDetail.box === boxIdx &&
      openDetail.line === lineIdx &&
      openDetail.word === wordIdx;
    openDetail = same ? null : { box: boxIdx, line: lineIdx, word: wordIdx };
  }

  let openTranslation: number | null = null;
  function toggleTranslation(e: MouseEvent, boxIdx: number) {
    e.stopPropagation();
    openTranslation = openTranslation === boxIdx ? null : boxIdx;
  }

    // Copy support
  let copiedBox: number | null = null;
  let copyTimer: ReturnType<typeof setTimeout> | null = null;

  function getTextToCopy(
    lines: string[],
    line_translations?: { words: { word: string }[] }[]
  ): string {
    if (line_translations?.length) {
      return line_translations
        .map((l) => (l.words ?? []).map((w) => w.word).join(''))
        .join('\n');
    }
    return (lines ?? []).join('\n');
  }

  async function copyText(
    e: MouseEvent,
    lines: string[],
    line_translations: { words: { word: string }[] }[] | undefined,
    boxIdx: number
  ) {
    e.stopPropagation();
    try {
      const text = getTextToCopy(lines, line_translations);
      await navigator.clipboard.writeText(text);
      copiedBox = boxIdx;
      if (copyTimer) clearTimeout(copyTimer);
      copyTimer = setTimeout(() => (copiedBox = null), 1500);
    } catch {
      // no-op; could add toast if desired
    }
  }
</script>

{#each textBoxes as { fontSize, height, left, lines, line_translations, translation, top, width, writingMode }, index (`textBox-${index}`)}
  <div
    class="textBox"
    style:width
    style:height
    style:left
    style:top
    style:font-size={fontSize}
    style:font-weight={fontWeight}
    style:display
    style:border
    style:writing-mode={writingMode}
    role="none"
    on:contextmenu={(e) => onContextMenu(e, lines)}
    on:dblclick={(e) => onDoubleTap(e, lines)}
    on:click={() => { openDetail = null; openTranslation = null; }}
    {contenteditable}
  >
    {#if line_translations?.length > 0}
      {#each line_translations as line, lineIdx}
        <p>{#each line.words as word, wordIdx}
          <span class="wordWrapper">
            <span
              class="word"
              on:click={(e) => toggleDetail(e, index, lineIdx, wordIdx)}
              >{word.word}</span
            >
            <div
              class="wordDetail"
              class:show={!!openDetail &&
                openDetail.box === index &&
                openDetail.line === lineIdx &&
                openDetail.word === wordIdx}
            >
              {#if word.word !== word.hiragana}
                <span>{word.word} ({word.hiragana})<br></span>
              {:else}
                <span>{word.word}<br></span>
              {/if}
              {#if word.word !== word.dictionary_entry}
                {#if word.dictionary_entry !== word.dictionary_hiragana}
                  <span>{word.dictionary_entry} ({word.dictionary_hiragana})<br></span>
                {:else}
                  <span>{word.dictionary_entry}<br></span>
                {/if}
              {/if}
              <span>{word.sentence_form}<br></span>
              <span>{word.meaning}<br></span>
            </div>
          </span>
        {/each}</p>
      {/each}
    {:else}
      {#each lines as line}
        <p>{line}</p>
      {/each}
    {/if}
    {#if translation?.trim()}
      <span class="actionWrapper">
        <span
          class="translationIcon"
          title="Show translation"
          on:click={(e) => toggleTranslation(e, index)}
          >💬</span
        >
        <span
          class="copyIcon"
          title="Copy text"
          on:click={(e) => copyText(e, lines, line_translations, index)}
        >{copiedBox === index ? '✅' : '📋'}</span>
        <div class="translationDetail" class:show={openTranslation === index}>
          <div class="translationContent">{translation}</div>
        </div>
      </span>
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
    white-space: nowrap;
    border: 1px solid rgba(0, 0, 0, 0);
    z-index: 11;
  }

  .wordWrapper {
    position: relative;
    display: inline-block;
  }

  .word:hover {
    text-decoration: underline;
    cursor: pointer;
  }

  .textBox:focus,
  .textBox:hover {
    background: rgb(255, 255, 255);
    border: 1px solid rgba(0, 0, 0, 0);
  }

  .wordDetail {
    display: none;
    position: absolute;
    left: 0;
    top: 100%;
    background-color: white;
    border: 1px solid black;
    padding: 5px;
    z-index: 12;
    white-space: normal;
    writing-mode: horizontal-tb;  
    text-orientation: mixed;
    direction: ltr;
    width: max-content;
    max-width: 48rem;
  }
   .wordDetail.show {
    display: block;
  }


  .textBox p {
    display: none;
    white-space: nowrap;
    letter-spacing: 0.1em;
    line-height: 1.1em;
    margin: 0;
    background-color: rgb(255, 255, 255);
    font-weight: var(--bold);
    z-index: 11;
  }

  .actionWrapper {
    position: relative;
    display: none;
  }
  .textBox:hover .actionWrapper,
  .textBox:focus .actionWrapper {
    display: inline-block; /* show on hover/focus like the lines */
  }
  .copyIcon,
  .translationIcon {
    cursor: pointer;
    user-select: none;
    font-size: 0.95em;
    line-height: 1;
    margin-left: 4px;
  }
  .translationDetail {
    display: none;
    position: absolute;
    left: 0;
    top: 100%;
    background-color: white;
    border: 1px solid black;
    padding: 6px;
    z-index: 12;
    white-space: normal;
    writing-mode: horizontal-tb;
    text-orientation: mixed;
    direction: ltr;
    width: max-content;
    max-width: 48rem;
    box-shadow: 0 2px 6px rgba(0,0,0,0.15);
  }
  .translationDetail.show {
    display: block;
  }
  .translationContent {
    /* ensure it's not affected by .textBox p rules */
    display: block;
    white-space: normal;
    margin: 0;
  }
  /* Progressive enhancement: CSS Anchor Positioning */
  @supports (anchor-name: --a) and (position-try: flip-inline) {
    /* Make the icon an anchor */
    .actionWrapper .wordWrapper {
      anchor-name: --tr;
      writing-mode: horizontal-tb; /* inline axis = left/right */
    }

    .translationDetail .wordDetail {
      /* Anchor to viewport to avoid ancestor clipping and test against screen edges */
      position: fixed;
      position-anchor: --tr;
      inset: auto;

      /* Default: below + left-aligned (opens to the right) */
      top: anchor(--tr bottom);
      left: anchor(--tr left);
      translate: 0 6px;

      /* Let UA flip horizontally/vertically to avoid overflow */
      position-try: flip-inline flip-block;
      position-try-order: most-width;

      /* Keep width within the viewport inline size */
      max-inline-size: 90vi; /* vi = viewport inline axis */
    }
  }

  .textBox:focus p,
  .textBox:hover p {
    display: table;
  }
</style>
