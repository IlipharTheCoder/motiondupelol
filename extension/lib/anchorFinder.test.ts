// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { findSidebarAnchor } from './anchorFinder';

// The literal DOM dump captured live from calendar.notion.so during
// planning (extension-plan.md, section 1) — using the real fixture, not a
// hand-simplified approximation, so this test would actually catch a
// regression against what Notion really serves.
const REAL_FIXTURE = `<div class="sc-1je7ayr-2 bZnsQW"><div class="sc-1je7ayr-1 enHWcn"><div class="sc-1je7ayr-0 evkbMl" style="opacity: 1; transform: none;"><div class="sc-6jgiuu-0 sc-16a6nl7-8 krlKcg fuqqCb"><div class="sc-15zpq92-10 fheZZs sc-16a6nl7-3 jMglsN"><div class="sc-15zpq92-9 hZdtxs"><div class="sc-1gvbi80-6 jWoIuA" style="--container-width: 232px;"><div class="sc-1gvbi80-5 omDLg"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 20 20" style="width: 18px; height: 18px;"><path fill="currentColor" d="M14.75 10.875a3.625 3.625 0 0 1 2.938 5.747"></path></svg></div><input data-subdued="true" autocomplete="off" placeholder="Search events" autocapitalize="off" spellcheck="false" data-form-type="other" data-lpignore="true" data-input="true" type="text" value=""><div aria-hidden="true" class="sc-1gvbi80-4 fQjRWC">Search events</div></div><div class="sc-15zpq92-8 ihTExJ"><button aria-describedby="tooltip-qz1sh3wjt" class="sc-gfyskm-3 domPjm sc-egm50s-0 cFKGCs" type="button"><div class="sc-gfyskm-2 bEjQfc"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 20 20" style="width: 18px; height: 18px;"><path fill="currentColor" d="M16.25 3.625c1.174 0 2.125.951 2.125 2.125v8.5"></path></svg></div></button></div></div><div class="sc-15zpq92-6 YVqJy"></div></div><div class="sc-16a6nl7-7 gYxDPd"><div class="sc-16a6nl7-1 eDDfyz"><div class="sc-16a6nl7-0 bTBvev">Useful shortcuts</div><ul class="sc-16a6nl7-6 hbgxlg"><li class="sc-16a6nl7-5 joRrtx"><div class="sc-16a6nl7-4 bbwWmJ">Command menu</div><span class="sc-rc1qsi-3 dWJYjF"><kbd class="sc-rc1qsi-1 bReyGY">⌘</kbd><kbd class="sc-rc1qsi-1 bReyGY">K</kbd></span></li><li class="sc-16a6nl7-5 joRrtx"><div class="sc-16a6nl7-4 bbwWmJ">Toggle sidebar</div><span class="sc-rc1qsi-3 dWJYjF"><kbd class="sc-rc1qsi-1 bReyGY">\`</kbd></span></li></ul></div></div></div></div></div></div>`;

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

describe('findSidebarAnchor', () => {
  it('finds a container that holds both the search input and the shortcuts list, against the real captured fixture', () => {
    const doc = parse(REAL_FIXTURE);
    const anchor = findSidebarAnchor(doc);
    expect(anchor).not.toBeNull();
    expect(anchor!.querySelector('input[placeholder="Search events"]')).not.toBeNull();
    expect(anchor!.textContent).toContain('Useful shortcuts');
  });

  it('does not return the whole document/body — the anchor is a specific, tighter container', () => {
    const doc = parse(REAL_FIXTURE);
    const anchor = findSidebarAnchor(doc);
    expect(anchor).not.toBe(doc.body);
    expect(anchor?.tagName).not.toBe('HTML');
  });

  it('returns null when the search input is missing', () => {
    const html = REAL_FIXTURE.replace(/<input[^>]*placeholder="Search events"[^>]*>/, '');
    expect(findSidebarAnchor(parse(html))).toBeNull();
  });

  it('returns null when the "Useful shortcuts" text is missing', () => {
    const html = REAL_FIXTURE.replace('Useful shortcuts', 'Something else entirely');
    expect(findSidebarAnchor(parse(html))).toBeNull();
  });

  it('succeeds against a minimal synthetic fixture with DIFFERENT hash classes than the captured one — proving the algorithm keys on content, not any specific sc-XXXXX-N string', () => {
    const synthetic = `
      <div class="totally-different-hash-zz9x">
        <div class="another-random-hash-q7f2">
          <input placeholder="Search events" type="text" />
        </div>
        <div class="yet-another-hash-m3k8">
          <div class="whatever-1a2b">Useful shortcuts</div>
        </div>
      </div>
    `;
    const anchor = findSidebarAnchor(parse(synthetic));
    expect(anchor).not.toBeNull();
    expect(anchor!.querySelector('input[placeholder="Search events"]')).not.toBeNull();
    expect(anchor!.textContent).toContain('Useful shortcuts');
  });
});
