// Locates the Notion Calendar sidebar's default-state content by CONTENT,
// never by its styled-components class names (sc-XXXXX-N pattern) — those
// are assumed to regenerate on Notion's next deploy (see extension/CLAUDE.md).
// Finds the "Search events" input and the "Useful shortcuts" heading
// independently, then returns their lowest common ancestor — the container
// whose content gets replaced by the panel. Returns null (never throws) if
// either landmark is missing; content-script.ts decides how to log/retry.

function findElementByExactText(root: ParentNode, text: string): Element | null {
  const doc = root.ownerDocument ?? (root as Document);
  const walker = doc.createTreeWalker(root as unknown as Node, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if (node.textContent?.trim() === text) {
      return node.parentElement;
    }
  }
  return null;
}

function ancestorChain(el: Element): Element[] {
  const chain: Element[] = [];
  let current: Element | null = el;
  while (current) {
    chain.unshift(current);
    current = current.parentElement;
  }
  return chain;
}

function lowestCommonAncestor(a: Element, b: Element): Element | null {
  const chainA = ancestorChain(a);
  const chainB = ancestorChain(b);
  let lca: Element | null = null;
  const len = Math.min(chainA.length, chainB.length);
  for (let i = 0; i < len; i++) {
    if (chainA[i] !== chainB[i]) break;
    lca = chainA[i];
  }
  return lca;
}

export function findSidebarAnchor(root: ParentNode): Element | null {
  const searchInput = root.querySelector('input[placeholder="Search events"]');
  const shortcutsHeading = findElementByExactText(root, 'Useful shortcuts');
  if (!searchInput || !shortcutsHeading) return null;
  return lowestCommonAncestor(searchInput, shortcutsHeading);
}
