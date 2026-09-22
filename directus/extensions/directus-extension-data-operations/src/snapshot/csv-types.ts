// The records, limits and refusals of the snapshot CSV reader
// (csv-parser.ts).

export type CsvCell = null | string;

export type CsvProblem =
  | 'bare_carriage_return'
  | 'cell_too_long'
  | 'empty_line'
  | 'encoding'
  | 'nul_character'
  | 'quote_in_unquoted_cell'
  | 'text_after_quote'
  | 'too_many_cells'
  | 'unterminated_quote';

export type CsvRecord = {
  readonly cells: readonly CsvCell[];
  // The physical line the record starts on (1-based) and its record index
  // (0 for the header).
  readonly line: number;
  readonly record: number;
};

export class CsvFormatError extends Error {
  public readonly line: number;
  public override readonly name = 'CsvFormatError';
  public readonly problem: CsvProblem;

  public constructor(
    message: string,
    options: ErrorOptions & {
      readonly line: number;
      readonly problem: CsvProblem;
    },
  ) {
    super(message, options);
    this.line = options.line;
    this.problem = options.problem;
  }
}

export const refuse = (
  problem: CsvProblem,
  line: number,
  cause?: unknown,
): CsvFormatError =>
  new CsvFormatError(`${problem.replaceAll('_', ' ')} on line ${line}`, {
    cause,
    line,
    problem,
  });

export type CsvLimits = {
  readonly maxCellChars: number;
  readonly maxCells: number;
};
