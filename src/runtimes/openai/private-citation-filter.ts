const OPENAI_PRIVATE_MARKUP_START = "\uE200";
const OPENAI_PRIVATE_MARKUP_END = "\uE201";
const OPENAI_PRIVATE_CITATION_PREFIX = `${OPENAI_PRIVATE_MARKUP_START}cite\uE202`;
const MAX_PENDING_PRIVATE_CITATION_CHARS = 4_096;

export interface OpenAiPrivateCitationFilterResult {
  readonly privateCitationCount: number;
  readonly text: string;
}

interface OpenAiPrivateCitationScanResult extends OpenAiPrivateCitationFilterResult {
  readonly pendingMarkup: string;
}

function scanOpenAiPrivateCitations(
  text: string,
  options: { readonly preserveIncompleteMarkup: boolean },
): OpenAiPrivateCitationScanResult {
  let cursor = 0;
  let privateCitationCount = 0;
  let sanitizedText = "";

  while (cursor < text.length) {
    const markupStart = text.indexOf(OPENAI_PRIVATE_MARKUP_START, cursor);

    if (markupStart === -1) {
      sanitizedText += text.slice(cursor);
      break;
    }

    sanitizedText += text.slice(cursor, markupStart);
    const remainingText = text.slice(markupStart);

    if (
      options.preserveIncompleteMarkup &&
      OPENAI_PRIVATE_CITATION_PREFIX.startsWith(remainingText)
    ) {
      return {
        pendingMarkup: remainingText,
        privateCitationCount,
        text: sanitizedText,
      };
    }

    if (!text.startsWith(OPENAI_PRIVATE_CITATION_PREFIX, markupStart)) {
      sanitizedText += OPENAI_PRIVATE_MARKUP_START;
      cursor = markupStart + OPENAI_PRIVATE_MARKUP_START.length;
      continue;
    }

    const markupEnd = text.indexOf(
      OPENAI_PRIVATE_MARKUP_END,
      markupStart + OPENAI_PRIVATE_CITATION_PREFIX.length,
    );

    if (markupEnd === -1) {
      if (options.preserveIncompleteMarkup) {
        return {
          pendingMarkup: remainingText,
          privateCitationCount,
          text: sanitizedText,
        };
      }

      sanitizedText += remainingText;
      break;
    }

    privateCitationCount += 1;
    cursor = markupEnd + OPENAI_PRIVATE_MARKUP_END.length;
  }

  return {
    pendingMarkup: "",
    privateCitationCount,
    text: sanitizedText,
  };
}

export function filterOpenAiPrivateCitations(text: string): OpenAiPrivateCitationFilterResult {
  const result = scanOpenAiPrivateCitations(text, { preserveIncompleteMarkup: false });

  return {
    privateCitationCount: result.privateCitationCount,
    text: result.text,
  };
}

export class OpenAiPrivateCitationStreamFilter {
  #discardUntilEnd = false;
  #pendingMarkup = "";

  push(delta: string): OpenAiPrivateCitationFilterResult {
    let input = delta;
    let discardedCitationCount = 0;

    if (this.#discardUntilEnd) {
      const markupEnd = input.indexOf(OPENAI_PRIVATE_MARKUP_END);

      if (markupEnd === -1) {
        return { privateCitationCount: 0, text: "" };
      }

      this.#discardUntilEnd = false;
      discardedCitationCount = 1;
      input = input.slice(markupEnd + OPENAI_PRIVATE_MARKUP_END.length);
    }

    const result = scanOpenAiPrivateCitations(this.#pendingMarkup + input, {
      preserveIncompleteMarkup: true,
    });
    this.#pendingMarkup = result.pendingMarkup;

    if (this.#pendingMarkup.length > MAX_PENDING_PRIVATE_CITATION_CHARS) {
      this.#pendingMarkup = "";
      this.#discardUntilEnd = true;
    }

    return {
      privateCitationCount: discardedCitationCount + result.privateCitationCount,
      text: result.text,
    };
  }

  finish(): OpenAiPrivateCitationFilterResult {
    const result = this.previewFinish();
    this.#discardUntilEnd = false;
    this.#pendingMarkup = "";
    return result;
  }

  previewFinish(): OpenAiPrivateCitationFilterResult {
    if (this.#discardUntilEnd) {
      return { privateCitationCount: 0, text: "" };
    }

    const result = scanOpenAiPrivateCitations(this.#pendingMarkup, {
      preserveIncompleteMarkup: false,
    });

    return {
      privateCitationCount: result.privateCitationCount,
      text: result.text,
    };
  }
}
