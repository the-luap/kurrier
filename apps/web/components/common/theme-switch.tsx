import { Switch } from "@mantine/core";
import { IconMoonStars, IconSun } from "@tabler/icons-react";
import { useSyncExternalStore } from "react";
import { useAppearance } from "@/components/providers/appearance-provider";
import { useOptionalDictionary } from "@/components/providers/dictionary-provider";

const DARK_QUERY = "(prefers-color-scheme: dark)";

function subscribePrefersDark(onChange: () => void) {
	const mq = window.matchMedia(DARK_QUERY);
	mq.addEventListener("change", onChange);
	return () => mq.removeEventListener("change", onChange);
}

// Hydration-safe (server snapshot = false) and follows OS changes, unlike a
// one-off `window.matchMedia` read memoized on mount.
function usePrefersDark() {
	return useSyncExternalStore(
		subscribePrefersDark,
		() => window.matchMedia(DARK_QUERY).matches,
		() => false,
	);
}

function ThemeSwitch({ onComplete }: { onComplete?: () => void }) {
	const { mode, setMode } = useAppearance();
	const dict = useOptionalDictionary();
	const prefersDark = usePrefersDark();

	const isDark =
		mode === "dark" ? true : mode === "light" ? false : prefersDark;

	return (
		<Switch
			size="sm"
			checked={!isDark}
			onChange={(e) => {
				setMode(e.currentTarget.checked ? "light" : "dark");
				onComplete?.();
			}}
			onLabel={<IconSun size={16} stroke={2.5} />}
			offLabel={<IconMoonStars size={16} stroke={2.5} />}
			aria-label={
				isDark
					? (dict?.common?.switchToLightMode ?? "Switch to light mode")
					: (dict?.common?.switchToDarkMode ?? "Switch to dark mode")
			}
		/>
	);
}

export default ThemeSwitch;
