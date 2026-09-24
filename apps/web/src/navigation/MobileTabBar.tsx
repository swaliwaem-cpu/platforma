import { useEffect, useState } from 'react';
import { MenuIcon, type LucideIcon } from 'lucide-react';

export type MobileTab = {
  id: string;
  label: string;
  icon: LucideIcon;
  onSelect: () => void;
};

type MobileTabBarProps = {
  tabs: readonly MobileTab[];
  activeTabId: string | null;
  isMenuOpen: boolean;
  onToggleMenu: () => void;
};

// Scrolling less than this is treated as jitter (iOS rubber band, momentum tails).
const scrollDeltaThreshold = 8;
// Near the top of the page the bar always stays visible.
const revealTopOffset = 64;

/**
 * Phone navigation bar, shown only below 760px by CSS. Like most mobile sites it
 * slides away while the page scrolls down and comes back on any scroll up.
 */
export function MobileTabBar({ tabs, activeTabId, isMenuOpen, onToggleMenu }: MobileTabBarProps) {
  const [isScrolledAway, setIsScrolledAway] = useState(false);

  useEffect(() => {
    let lastScrollY = Math.max(window.scrollY, 0);
    let frameId = 0;

    const updateVisibility = () => {
      frameId = 0;
      const scrollY = Math.max(window.scrollY, 0);
      const delta = scrollY - lastScrollY;

      if (Math.abs(delta) < scrollDeltaThreshold) {
        return;
      }

      setIsScrolledAway(delta > 0 && scrollY > revealTopOffset);
      lastScrollY = scrollY;
    };

    const handleScroll = () => {
      if (!frameId) {
        frameId = window.requestAnimationFrame(updateVisibility);
      }
    };

    window.addEventListener('scroll', handleScroll, { passive: true });

    return () => {
      window.removeEventListener('scroll', handleScroll);
      window.cancelAnimationFrame(frameId);
    };
  }, []);

  const isHidden = isScrolledAway && !isMenuOpen;

  return (
    <nav className={isHidden ? 'mobile-tabbar is-hidden' : 'mobile-tabbar'} aria-label="Мобильная навигация">
      {tabs.map((tab) => {
        const isActive = !isMenuOpen && tab.id === activeTabId;

        return (
          <button
            key={tab.id}
            aria-current={isActive ? 'page' : undefined}
            className={isActive ? 'mobile-tabbar-item is-active' : 'mobile-tabbar-item'}
            type="button"
            onClick={tab.onSelect}
          >
            <tab.icon aria-hidden="true" />
            <span>{tab.label}</span>
          </button>
        );
      })}
      <button
        aria-controls="main-sidebar-content"
        aria-expanded={isMenuOpen}
        className={isMenuOpen ? 'mobile-tabbar-item is-active' : 'mobile-tabbar-item'}
        type="button"
        onClick={onToggleMenu}
      >
        <MenuIcon aria-hidden="true" />
        <span>Меню</span>
      </button>
    </nav>
  );
}
