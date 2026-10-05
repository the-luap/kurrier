"use client";

import React, {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
	useTransition,
} from "react";
import { useRouter } from "next/navigation";
import type { ThemeName, ThemeMode } from "@schema/types/themes";
import {
	setModeServer,
	setResolvedServer,
	setThemeServer,
} from "@/lib/actions/appearance";
import { Toaster } from "@/components/ui/sonner";

type ResolvedMode = "light" | "dark";

type AppearanceCtx = {
	theme: ThemeName;
	mode: ThemeMode;
	setTheme: (t: ThemeName) => void;
	setMode: (m: ThemeMode) => void;
	pending: boolean;
	applyColorScheme: (mode: ThemeMode) => void;
};

const Ctx = createContext<AppearanceCtx | null>(null);

const DARK_QUERY = "(prefers-color-scheme: dark)";

/**
 * Applies the resolved color scheme to <html> for Tailwind (`.dark`), native
 * controls (`color-scheme`) and Mantine (`data-mantine-color-scheme`).
 * Module-level so its identity is stable across renders.
 */
function applyColorScheme(mode: ThemeMode): ResolvedMode {
	const el = document.documentElement;
	const isDark =
		mode === "dark" ||
		(mode === "system" && window.matchMedia(DARK_QUERY).matches);

	el.classList.toggle("dark", isDark);
	el.style.setProperty("color-scheme", isDark ? "dark" : "light");
	el.setAttribute("data-mantine-color-scheme", isDark ? "dark" : "light");

	return isDark ? "dark" : "light";
}

export function AppearanceProvider({
	children,
	initialTheme,
	initialMode,
	initialResolved,
}: {
	children: React.ReactNode;
	initialTheme: ThemeName;
	initialMode: ThemeMode;
	/** Value of the resolved-mode cookie the server rendered with (if any). */
	initialResolved?: ResolvedMode;
}) {
	const router = useRouter();
	const [pending, start] = useTransition();
	const [theme, setThemeState] = useState<ThemeName>(initialTheme);
	const [mode, setModeState] = useState<ThemeMode>(initialMode);
	// Last resolved value persisted in the cookie; avoids a server action round
	// trip on every page load when nothing changed.
	const persistedResolved = useRef<ResolvedMode | undefined>(initialResolved);

	// Keep DOM synced with theme
	useEffect(() => {
		document.documentElement.setAttribute("data-theme", theme);
	}, [theme]);

	// Keep DOM (+ resolved cookie for "system") synced with mode. A single
	// listener handles OS-level changes while in "system" mode.
	useEffect(() => {
		const syncResolved = (resolved: ResolvedMode) => {
			if (persistedResolved.current === resolved) return;
			persistedResolved.current = resolved;
			void setResolvedServer(resolved);
		};

		const resolved = applyColorScheme(mode);
		if (mode !== "system") {
			// setModeServer already stores the resolved cookie for explicit modes
			persistedResolved.current = resolved;
			return;
		}
		syncResolved(resolved);

		const mq = window.matchMedia(DARK_QUERY);
		const onChange = () => syncResolved(applyColorScheme("system"));
		mq.addEventListener("change", onChange);
		return () => mq.removeEventListener("change", onChange);
	}, [mode]);

	const setTheme = useCallback(
		(t: ThemeName) => {
			setThemeState(t);
			document.documentElement.setAttribute("data-theme", t);
			start(async () => {
				await setThemeServer(t);
				router.refresh();
			});
		},
		[router],
	);

	const setMode = useCallback(
		(m: ThemeMode) => {
			setModeState(m);
			applyColorScheme(m);
			start(async () => {
				await setModeServer(m);
				router.refresh();
			});
		},
		[router],
	);

	const value = useMemo(
		() => ({ theme, mode, setTheme, setMode, pending, applyColorScheme }),
		[theme, mode, setTheme, setMode, pending],
	);

	return (
		<Ctx.Provider value={value}>
			<Toaster theme={mode} expand={true} />
			{children}
		</Ctx.Provider>
	);
}

export function useAppearance() {
	const ctx = useContext(Ctx);
	if (!ctx)
		throw new Error("useAppearance must be used within <AppearanceProvider>");
	return ctx;
}
