"use client";

import { Button, CommandPalette, Kbd } from "@astryxdesign/core";
import type { SearchSource, SearchableItem } from "@astryxdesign/core";
import { Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { flattenNavItems, toSearchKey, visibleNavSections } from "@/ui/components/shell/nav-items";
import { useMe } from "@/ui/hooks/useMe";

/**
 * Jump-to-screen search in the top bar: a visible trigger plus the same palette
 * on Cmd/Ctrl+K. The shortcut never stands alone — a keyboard-only affordance is
 * one nobody discovers (core-keyboard-shortcuts).
 *
 * Destinations come from NAV_SECTIONS, so a nav entry added there shows up here
 * with no second list to keep in step.
 */

interface NavSearchAux {
  /** Section heading; CommandPalette groups the list by it. */
  group: string;
  /** Diacritic-free form of the label, matched against a folded query. */
  searchKey: string;
}

/** `auxiliaryData` is optional upstream; here every item carries it. */
interface NavSearchItem extends SearchableItem<NavSearchAux> {
  auxiliaryData: NavSearchAux;
}

/**
 * Matching folds BOTH sides through `toSearchKey`. Astryx's `createStaticSource`
 * only lower-cases the query, which would leave "đong bo" — the common half-typed
 * spelling, đ but no tone marks — matching neither the label nor an alias.
 */
function createNavSource(items: readonly NavSearchItem[]): SearchSource<NavSearchItem> {
  return {
    search(query) {
      const needle = toSearchKey(query).trim();
      if (needle === "") return [...items];
      return items.filter((item) => item.auxiliaryData.searchKey.includes(needle));
    },
    bootstrap() {
      return [...items];
    },
  };
}

export function AppSearch() {
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  const me = useMe();
  // Same filter as the sidebar: hiding a section from the nav but leaving it
  // findable in the palette would be hiding nothing at all (M3.2 / ticket N3).
  const hasPlatformRole = (me.data?.account?.platformRole ?? null) !== null;

  const searchSource = useMemo(() => {
    const items: NavSearchItem[] = flattenNavItems(visibleNavSections({ hasPlatformRole })).map(
      (item) => ({
        id: item.href,
        label: item.label,
        auxiliaryData: { group: item.section, searchKey: toSearchKey(item.label) },
      }),
    );

    return createNavSource(items);
  }, [hasPlatformRole]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "k") return;
      // Chrome focuses the address bar on Cmd+K; the app owns the shortcut here.
      event.preventDefault();
      // Toggling, not opening: pressing it again is how people close a palette.
      setIsOpen((wasOpen) => !wasOpen);
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <>
      <Button
        variant="secondary"
        size="sm"
        icon={<Search aria-hidden="true" />}
        label="Tìm màn hình"
        endContent={<Kbd keys="mod+k" />}
        onClick={() => setIsOpen(true)}
      />
      <CommandPalette
        isOpen={isOpen}
        onOpenChange={setIsOpen}
        // The palette closes itself on select; only the navigation is ours.
        onValueChange={(href) => router.push(href)}
        searchSource={searchSource}
        label="Tìm màn hình"
        emptySearchText="Không có màn hình nào khớp"
      />
    </>
  );
}
