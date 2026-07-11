const OPENAI_PRIVATE_MARKUP_START = "\uE200";
const OPENAI_PRIVATE_MARKUP_END = "\uE201";
const OPENAI_PRIVATE_CITATION_PREFIX = `${OPENAI_PRIVATE_MARKUP_START}cite\uE202`;

export interface OpenAiPrivateCitationFilterResult {
  readonly privateCitationCount: number;
  readonly text: string;
}

interface OpenAiPrivateCitationScanResult extends OpenAiPrivateCitationFilterResult {
  readonly hasPendingMarkup: boolean;
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
        hasPendingMarkup: true,
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
          hasPendingMarkup: true,
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
    hasPendingMarkup: false,
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
  #emittedTextLength = 0;
  #privateCitationCount = 0;
  #rawText = "";

  push(delta: string): OpenAiPrivateCitationFilterResult {
    this.#rawText += delta;
    const result = scanOpenAiPrivateCitations(this.#rawText, {
      preserveIncompleteMarkup: true,
    });
    const emittedText = result.text.slice(this.#emittedTextLength);
    const newlyDetectedCitations = result.privateCitationCount - this.#privateCitationCount;

    this.#emittedTextLength = result.text.length;
    this.#privateCitationCount = result.privateCitationCount;

    return {
      privateCitationCount: newlyDetectedCitations,
      text: emittedText,
    };
  }

  finish(): OpenAiPrivateCitationFilterResult {
    const result = scanOpenAiPrivateCitations(this.#rawText, {
      preserveIncompleteMarkup: false,
    });
    const emittedText = result.text.slice(this.#emittedTextLength);
    const newlyDetectedCitations = result.privateCitationCount - this.#privateCitationCount;

    this.#emittedTextLength = result.text.length;
    this.#privateCitationCount = result.privateCitationCount;

    return {
      privateCitationCount: newlyDetectedCitations,
      text: emittedText,
    };
  }
}
