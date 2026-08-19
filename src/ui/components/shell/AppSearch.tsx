"use client";

import { Button, CommandPalette, CommandPaletteFooter, HStack, Kbd, Text } from "@astryxdesign/core";
import type { SearchSource, SearchableItem } from "@astryxdesign/core";
import { Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { flattenNavItems, toSearchKey } from "@/ui/components/shell/nav-items";

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

/**
 * The palette's keyboard hints. Astryx hard-codes "Navigate / Select / Close"
 * inside CommandPaletteFooter instead of routing them through its locale
 * catalog, so the only way to say them in Vietnamese is to pass the slot.
 *
 * The key glyphs keep their English accessible names ("Up arrow", "Enter") —
 * those are hard-coded in Kbd with no slot to replace them.
 */
function PaletteFooter() {
  return (
    <CommandPaletteFooter>
      <HStack gap={1} vAlign="center">
        <Kbd keys="up" />
        <Kbd keys="down" />
        <Text type="supporting">Di chuyển</Text>
      </HStack>
      <HStack gap={1} vAlign="center">
        <Kbd keys="enter" />
        <Text type="supporting">Chọn</Text>
      </HStack>
      <HStack gap={1} vAlign="center">
        <Kbd keys="escape" />
        <Text type="supporting">Đóng</Text>
      </HStack>
    </CommandPaletteFooter>
  );
}

export function AppSearch() {
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);

  const searchSource = useMemo(() => {
    const items: NavSearchItem[] = flattenNavItems().map((item) => ({
      id: item.href,
      label: item.label,
      auxiliaryData: { group: item.section, searchKey: toSearchKey(item.label) },
    }));

    return createNavSource(items);
  }, []);

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
        footer={<PaletteFooter />}
      />
    </>
  );
}
