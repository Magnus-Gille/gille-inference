const MAX_TOKENS = 32_768;
const MAX_TOTAL_PIECE_BYTES = 131_072;
const MAX_INT32 = 2_147_483_647;

export type TokenizePiece = string | number[];

export interface TokenizeResponse {
  count: number;
  tokens: number[];
  pieces: TokenizePiece[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasValidUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff || Number.isNaN(next)) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

/** Parse the strict llama.cpp `/tokenize` with `with_pieces:true` response shape. */
export function parseTokenizeResponse(input: unknown): TokenizeResponse | null {
  if (!isRecord(input) || !Array.isArray(input.tokens) || input.tokens.length > MAX_TOKENS) {
    return null;
  }

  const tokens: number[] = [];
  const pieces: TokenizePiece[] = [];
  const encoder = new TextEncoder();
  let totalPieceBytes = 0;

  for (const entry of input.tokens) {
    if (!isRecord(entry)) return null;
    const keys = Object.keys(entry);
    if (keys.length !== 2 || !keys.includes("id") || !keys.includes("piece")) return null;

    const id = entry.id;
    if (typeof id !== "number" || !Number.isInteger(id) || id < 0 || id > MAX_INT32) {
      return null;
    }

    const piece = entry.piece;
    if (typeof piece === "string") {
      if (totalPieceBytes + piece.length > MAX_TOTAL_PIECE_BYTES || !hasValidUtf16(piece)) return null;
      const pieceBytes = encoder.encode(piece).byteLength;
      if (totalPieceBytes + pieceBytes > MAX_TOTAL_PIECE_BYTES) return null;
      totalPieceBytes += pieceBytes;
      tokens.push(id);
      pieces.push(piece);
      continue;
    }

    if (!Array.isArray(piece) || totalPieceBytes + piece.length > MAX_TOTAL_PIECE_BYTES) {
      return null;
    }
    const bytes: number[] = [];
    for (const byte of piece) {
      if (typeof byte !== "number" || !Number.isInteger(byte) || byte < 0 || byte > 255) {
        return null;
      }
      bytes.push(byte);
    }
    totalPieceBytes += bytes.length;
    tokens.push(id);
    pieces.push(bytes);
  }

  return { count: tokens.length, tokens, pieces };
}
