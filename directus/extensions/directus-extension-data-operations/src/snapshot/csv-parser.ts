// A strict, streaming RFC 4180 reader for Moodle snapshot files. It keeps
// every cell exactly as written: no trimming, no type guessing, no JSON
// parsing, quoted line breaks and quotes preserved. An unquoted empty cell
// reads as null (absent), a quoted empty cell as the empty string, so a
// backup written with the same convention round-trips losslessly. Records
// end at LF or CRLF; a bare CR outside quotes, a quote inside an unquoted
// cell, text after a closing quote, an unterminated quote, an empty line
// followed by another record, bytes that are not UTF-8 and a NUL character
// are refused with the line they occur on. Only the current record and a
// count of the empty lines seen since the last record are held in memory,
// however many empty lines the file carries.

import {
  type CsvCell,
  type CsvLimits,
  type CsvRecord,
  refuse,
} from './csv-types.js';

type Mode = 'after_cr' | 'after_quote' | 'quoted' | 'start' | 'unquoted';

const special = /[\n\r",]/gu;
const nul = '\u{0}';

class CsvReader {
  public readonly done: CsvRecord[] = [];
  public get line(): number {
    return this.#line;
  }
  // Empty lines since the last record, and the line of the first of them.
  #blankLines = 0;
  #cell = '';
  #cells: CsvCell[] = [];
  #firstBlankLine = 0;
  readonly #limits: CsvLimits;
  #line = 1;
  #mode: Mode = 'start';
  #quoted = false;
  #record = 0;

  #recordLine = 1;

  public constructor(limits: CsvLimits) {
    this.#limits = limits;
  }

  public feed(text: string): void {
    let index = 0;
    while (index < text.length) {
      index = this.#step(text, index);
    }
  }

  public finish(): void {
    if (this.#mode === 'quoted') {
      throw refuse('unterminated_quote', this.#recordLine);
    }
    if (this.#mode === 'after_cr') {
      throw refuse('bare_carriage_return', this.#line);
    }
    if (this.#mode !== 'start' || this.#cells.length > 0) {
      this.#endCell();
      this.#endRecord();
    }
    // Empty lines at the very end of a file are not records.
    this.#blankLines = 0;
  }

  #afterQuote(text: string, index: number): number {
    switch (text[index]) {
      case '\n':
        this.#endCell();
        this.#newline();
        break;
      case '\r':
        this.#endCell();
        this.#mode = 'after_cr';
        break;
      case '"':
        this.#append('"');
        this.#mode = 'quoted';
        break;
      case ',':
        this.#endCell();
        break;
      case undefined:
      default:
        throw refuse('text_after_quote', this.#line);
    }
    return index + 1;
  }

  #append(part: string): void {
    if (part.includes(nul)) {
      throw refuse('nul_character', this.#line);
    }
    this.#cell += part;
    if (this.#cell.length > this.#limits.maxCellChars) {
      throw refuse('cell_too_long', this.#recordLine);
    }
  }

  #endCell(): void {
    this.#cells.push(this.#cell === '' && !this.#quoted ? null : this.#cell);
    if (this.#cells.length > this.#limits.maxCells) {
      throw refuse('too_many_cells', this.#recordLine);
    }
    this.#cell = '';
    this.#quoted = false;
    this.#mode = 'start';
  }

  // An empty line is only counted: at the end of the file it is dropped,
  // before another record the file is refused at the first empty line.
  #endRecord(): void {
    const cells = this.#cells;
    this.#cells = [];
    if (cells.length === 1 && cells[0] === null) {
      if (this.#blankLines === 0) {
        this.#firstBlankLine = this.#recordLine;
      }
      this.#blankLines += 1;
      return;
    }
    if (this.#blankLines > 0) {
      throw refuse('empty_line', this.#firstBlankLine);
    }
    this.done.push({ cells, line: this.#recordLine, record: this.#record });
    this.#record += 1;
  }

  #inQuotes(text: string, index: number): number {
    const quote = text.indexOf('"', index);
    const end = quote === -1 ? text.length : quote;
    const part = text.slice(index, end);
    this.#append(part);
    let feed = part.indexOf('\n');
    while (feed !== -1) {
      this.#line += 1;
      feed = part.indexOf('\n', feed + 1);
    }
    if (quote === -1) {
      return text.length;
    }
    this.#mode = 'after_quote';
    return quote + 1;
  }

  #newline(): void {
    this.#endRecord();
    this.#line += 1;
    this.#recordLine = this.#line;
  }

  #step(text: string, index: number): number {
    switch (this.#mode) {
      case 'after_cr':
        if (text[index] !== '\n') {
          throw refuse('bare_carriage_return', this.#line);
        }
        this.#newline();
        this.#mode = 'start';
        return index + 1;
      case 'after_quote':
        return this.#afterQuote(text, index);
      case 'quoted':
        return this.#inQuotes(text, index);
      case 'start':
        if (text[index] === '"') {
          this.#quoted = true;
          this.#mode = 'quoted';
          return index + 1;
        }
        this.#mode = 'unquoted';
        return index;
      case 'unquoted':
        break;
    }
    return this.#unquoted(text, index);
  }

  #unquoted(text: string, index: number): number {
    special.lastIndex = index;
    const match = special.exec(text);
    const end = match?.index ?? text.length;
    this.#append(text.slice(index, end));
    switch (match?.[0]) {
      case '\n':
        this.#endCell();
        this.#newline();
        return end + 1;
      case '\r':
        this.#endCell();
        this.#mode = 'after_cr';
        return end + 1;
      case ',':
        this.#endCell();
        return end + 1;
      case undefined:
        return text.length;
      default:
        throw refuse('quote_in_unquoted_cell', this.#line);
    }
  }
}

// Reads records from byte or text chunks. A leading UTF-8 byte order mark
// is dropped; bytes that are not valid UTF-8 are refused, never replaced.
export const readCsv = async function* (
  chunks: AsyncIterable<string | Uint8Array> | Iterable<string | Uint8Array>,
  limits: CsvLimits,
): AsyncGenerator<CsvRecord> {
  const reader = new CsvReader(limits);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const decode = (chunk: string | Uint8Array, final: boolean): string => {
    if (typeof chunk === 'string') {
      return chunk;
    }
    try {
      return decoder.decode(chunk, { stream: !final });
    } catch (error) {
      throw refuse('encoding', reader.line, error);
    }
  };
  const take = (): CsvRecord[] => {
    const ready = [...reader.done];
    reader.done.length = 0;
    return ready;
  };
  for await (const chunk of chunks) {
    reader.feed(decode(chunk, false));
    yield* take();
  }
  reader.feed(decode(new Uint8Array(0), true));
  reader.finish();
  yield* take();
};
