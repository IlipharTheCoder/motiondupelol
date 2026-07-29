// The Tasks/Approvals tab switcher. Both tab contents are mounted once and
// kept alive (display:none toggling, never destroy/recreate) — this is what
// lets the Approvals badge stay accurate while the Tasks tab is active,
// since ApprovalQueue's poll keeps running regardless of which tab is
// visible (extension/CLAUDE.md's panel-structure section).
export interface TabDef {
  id: string;
  label: string;
  element: HTMLElement;
}

export interface TabsHandle {
  setBadge(tabId: string, count: number): void;
}

export function createTabs(container: HTMLElement, tabs: TabDef[]): TabsHandle {
  const bar = document.createElement('div');
  bar.className = 'ai-cal-tabbar';

  const buttons = new Map<string, { button: HTMLButtonElement; badge: HTMLSpanElement }>();

  function activate(id: string): void {
    for (const tab of tabs) {
      const isActive = tab.id === id;
      tab.element.style.display = isActive ? '' : 'none';
      buttons.get(tab.id)?.button.classList.toggle('active', isActive);
    }
  }

  tabs.forEach((tab, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ai-cal-tab';
    button.textContent = tab.label;
    const badge = document.createElement('span');
    badge.className = 'ai-cal-tab-badge';
    badge.style.display = 'none';
    button.appendChild(badge);
    button.addEventListener('click', () => activate(tab.id));
    bar.appendChild(button);
    buttons.set(tab.id, { button, badge });
    if (index === 0) activate(tab.id);
  });

  container.appendChild(bar);

  return {
    setBadge(tabId: string, count: number): void {
      const entry = buttons.get(tabId);
      if (!entry) return;
      entry.badge.textContent = String(count);
      entry.badge.style.display = count > 0 ? '' : 'none';
    },
  };
}
