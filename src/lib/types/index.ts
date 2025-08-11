export type Block = {
  box: number[];
  vertical: boolean;
  font_size: number;
  lines: string[];
  translation: string;
  line_translations: LineTranslation[];
};

export type LineTranslation = {
  words: Word[];
}

export type Word = {
  word: string;
  dictionary_entry: string;
  meaning: string;
  sentence_form: string;
}

export type Page = {
  version: string;
  img_width: number;
  img_height: number;
  blocks: Block[];
  img_path: string;
};

export type MokuroData = {
  version: string;
  title: string;
  title_uuid: string;
  volume: string;
  volume_uuid: string;
  pages: Page[];
};

export type Volume = {
  mokuroData: MokuroData;
  volumeName: string;
  files: Record<string, File>;
};
