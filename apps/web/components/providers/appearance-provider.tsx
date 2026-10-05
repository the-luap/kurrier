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

type AppearanceCtx = {
	theme: ThemeName;
	mode: ThemeMode;
	setTheme: (theme: ThemeName) => void;
	setWorkspaceTheme: (theme: ThemeName | null) => void;
	setMode: (mode: ThemeMode) => void;
	pending: boolean;
};

type ResolvedMode = "light" | "dark";

const Ctx = createContext<AppearanceCtx | null>(null);

const DARK_QUERY = "(prefers-color-scheme: dark)";

function applyMode(isDark: boolean) {
	const el = document.documentElement;

	el.classList.toggle("dark", isDark);
	el.style.setProperty("color-scheme", isDark ? "dark" : "light");
	el.setAttribute("data-mantine-color-scheme", isDark ? "dark" : "light");
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
	const [workspaceTheme, setWorkspaceTheme] = useState<ThemeName | null>(null);
	const [mode, setModeState] = useState<ThemeMode>(initialMode);

	const activeTheme = workspaceTheme ?? theme;
	// Last resolved value persisted in the cookie; avoids a server action round
	// trip on every page load in "system" mode when nothing changed.
	const persistedResolved = useRef<ResolvedMode | undefined>(initialResolved);

	useEffect(() => {
		setThemeState(initialTheme);
	}, [initialTheme]);

	useEffect(() => {
		document.documentElement.setAttribute("data-theme", activeTheme);
	}, [activeTheme]);

	useEffect(() => {
		if (mode === "dark" || mode === "light") {
			applyMode(mode === "dark");
			// setModeServer already stores the resolved cookie for explicit modes.
			persistedResolved.current = mode;
			return;
		}

		const media = window.matchMedia(DARK_QUERY);

		const syncSystemMode = (isDark: boolean) => {
			applyMode(isDark);
			const resolved: ResolvedMode = isDark ? "dark" : "light";
			if (persistedResolved.current === resolved) return;
			persistedResolved.current = resolved;
			void setResolvedServer(resolved);
		};

		syncSystemMode(media.matches);

		const onChange = (event: MediaQueryListEvent) => {
			syncSystemMode(event.matches);
		};

		media.addEventListener("change", onChange);

		return () => {
			media.removeEventListener("change", onChange);
		};
	}, [mode]);

	const setTheme = useCallback(
		(nextTheme: ThemeName) => {
			setThemeState(nextTheme);

			if (workspaceTheme === null) {
				document.documentElement.setAttribute("data-theme", nextTheme);
			}

			start(async () => {
				await setThemeServer(nextTheme);
				router.refresh();
			});
		},
		[workspaceTheme, router],
	);

	const setMode = useCallback(
		(nextMode: ThemeMode) => {
			setModeState(nextMode);

			const isDark =
				nextMode === "dark" ||
				(nextMode === "system" &&
					window.matchMedia(DARK_QUERY).matches);

			applyMode(isDark);

			start(async () => {
				await setModeServer(nextMode);
				router.refresh();
			});
		},
		[router],
	);

	const value = useMemo(
		() => ({
			theme: activeTheme,
			mode,
			setTheme,
			setWorkspaceTheme,
			setMode,
			pending,
		}),
		[activeTheme, mode, setTheme, setMode, pending],
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

	if (!ctx) {
		throw new Error("useAppearance must be used within <AppearanceProvider>");
	}

	return ctx;
}
