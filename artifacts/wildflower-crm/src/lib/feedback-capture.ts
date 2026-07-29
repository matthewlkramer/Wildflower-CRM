import type { FeedbackContext } from "./feedback-api";

const MAX_CONTROLS = 60;
const MAX_TEST_IDS = 120;
const MAX_VALUE = 300;

function truncate(value: string, max = MAX_VALUE): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function visible(element: Element): boolean {
  if (!(element instanceof HTMLElement)) return false;
  if (element.hidden || element.closest('[aria-hidden="true"]')) return false;
  const style = window.getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden") return false;
  const rect = element.getBoundingClientRect();
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    rect.bottom >= 0 &&
    rect.right >= 0 &&
    rect.top <= window.innerHeight &&
    rect.left <= window.innerWidth
  );
}

function controlLabel(element: HTMLElement): string {
  const id = element.id;
  const explicitLabel = id
    ? document.querySelector<HTMLLabelElement>(`label[for="${CSS.escape(id)}"]`)
        ?.textContent
    : null;
  return truncate(
    (
      explicitLabel ||
      element.getAttribute("aria-label") ||
      element.getAttribute("name") ||
      element.getAttribute("data-testid") ||
      element.getAttribute("placeholder") ||
      element.textContent ||
      element.tagName.toLowerCase()
    ).trim(),
    160,
  );
}

function controlValue(
  element: HTMLElement,
): { value: string; kind: string } | null {
  if (element instanceof HTMLInputElement) {
    const type = element.type.toLowerCase();
    if (["password", "file", "hidden"].includes(type)) return null;
    if (["checkbox", "radio"].includes(type)) {
      return { value: element.checked ? "checked" : "not checked", kind: type };
    }
    return { value: truncate(element.value), kind: type || "input" };
  }
  if (element instanceof HTMLTextAreaElement) {
    return { value: truncate(element.value), kind: "textarea" };
  }
  if (element instanceof HTMLSelectElement) {
    return {
      value: truncate(
        Array.from(element.selectedOptions)
          .map((option) => option.textContent?.trim() || option.value)
          .join(", "),
      ),
      kind: "select",
    };
  }
  if (element.getAttribute("role") === "combobox") {
    return {
      value: truncate(
        element.getAttribute("aria-valuetext") ||
          element.textContent?.trim() ||
          "",
      ),
      kind: "combobox",
    };
  }
  return null;
}

export function collectFeedbackContext(): FeedbackContext {
  const root = document.querySelector("main") ?? document.body;
  const controls = Array.from(
    root.querySelectorAll<HTMLElement>(
      'input, textarea, select, [role="combobox"]',
    ),
  )
    .filter(visible)
    .flatMap((element) => {
      const captured = controlValue(element);
      return captured
        ? [
            {
              label: controlLabel(element),
              value: captured.value,
              kind: captured.kind,
            },
          ]
        : [];
    })
    .slice(0, MAX_CONTROLS);

  const activeTabs = Array.from(
    root.querySelectorAll<HTMLElement>('[role="tab"][data-state="active"]'),
  )
    .filter(visible)
    .map((element) =>
      truncate(element.textContent?.trim() || "Active tab", 160),
    );

  const activeControls = Array.from(
    root.querySelectorAll<HTMLElement>(
      '[aria-pressed="true"], [aria-current="page"], [data-state="on"]',
    ),
  )
    .filter(visible)
    .map(controlLabel)
    .slice(0, 40);

  const visibleTestIds = Array.from(
    root.querySelectorAll<HTMLElement>("[data-testid]"),
  )
    .filter(visible)
    .map((element) => element.dataset.testid || "")
    .filter(Boolean)
    .slice(0, MAX_TEST_IDS);

  return {
    capturedAt: new Date().toISOString(),
    url: window.location.href,
    pathname: window.location.pathname,
    search: window.location.search,
    hash: window.location.hash,
    pageTitle: document.title,
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio || 1,
    },
    screen: {
      width: window.screen?.width ?? window.innerWidth,
      height: window.screen?.height ?? window.innerHeight,
    },
    scroll: { x: window.scrollX, y: window.scrollY },
    browser: {
      userAgent: navigator.userAgent,
      language: navigator.language,
      platform: navigator.platform,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
    activeTabs,
    activeControls,
    controls,
    visibleTestIds,
  };
}

function dataUrlToFile(dataUrl: string, filename: string): Promise<File> {
  return fetch(dataUrl)
    .then((response) => response.blob())
    .then(
      (blob) => new File([blob], filename, { type: blob.type || "image/jpeg" }),
    );
}

export async function captureFeedbackScreenshot(): Promise<File> {
  const { toJpeg } = await import("html-to-image");
  const root = document.documentElement;
  const render = (quality: number, pixelRatio: number) =>
    toJpeg(root, {
      quality,
      pixelRatio,
      cacheBust: true,
      width: window.innerWidth,
      height: window.innerHeight,
      canvasWidth: Math.max(1, Math.round(window.innerWidth * pixelRatio)),
      canvasHeight: Math.max(1, Math.round(window.innerHeight * pixelRatio)),
      style: {
        transform: `translate(${-window.scrollX}px, ${-window.scrollY}px)`,
        transformOrigin: "top left",
      },
      filter: (node) => {
        if (!(node instanceof HTMLElement)) return true;
        return !node.closest("[data-feedback-ignore]");
      },
    });

  let file = await dataUrlToFile(
    await render(0.72, Math.min(window.devicePixelRatio || 1, 1.15)),
    `feedback-${new Date().toISOString().replaceAll(":", "-")}.jpg`,
  );
  if (file.size > 2_500_000) {
    file = await dataUrlToFile(
      await render(0.55, 0.8),
      `feedback-${new Date().toISOString().replaceAll(":", "-")}.jpg`,
    );
  }
  if (file.size > 5_000_000) {
    throw new Error("The screenshot was too large to attach.");
  }
  return file;
}
