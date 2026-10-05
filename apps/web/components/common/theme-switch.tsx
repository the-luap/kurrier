import React, { useSyncExternalStore } from "react";
import { IconMoonStars, IconSun } from "@tabler/icons-react";
import { Switch } from "@mantine/core";
import { useAppearance } from "@/components/providers/appearance-provider";

const DARK_QUERY = "(prefers-color-scheme: dark)";

function subscribePrefersDark(onChange: () => void) {
	const mq = window.matchMedia(DARK_QUERY);
	mq.addEventListener("change", onChange);
	return () => mq.removeEventListener("change", onChange);
}

// Hydration-safe (server snapshot = false) and follows OS changes, unlike the
// previous render-time `window.matchMedia` read inside useMemo.
function usePrefersDark() {
	return useSyncExternalStore(
		subscribePrefersDark,
		() => window.matchMedia(DARK_QUERY).matches,
		() => false,
	);
}

function ThemeSwitch({ onComplete }: { onComplete?: () => void }) {
	const { mode, setMode } = useAppearance();
	const prefersDark = usePrefersDark();

	const isDark =
		mode === "dark" ? true : mode === "light" ? false : prefersDark;

	return (
		<Switch
			size="sm"
			checked={!isDark}
			onChange={(e) => {
				setMode(e.currentTarget.checked ? "light" : "dark");
				onComplete && onComplete();
			}}
			onLabel={<IconSun size={16} stroke={2.5} />}
			offLabel={<IconMoonStars size={16} stroke={2.5} />}
			aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
		/>
	);
}

export default ThemeSwitch;
