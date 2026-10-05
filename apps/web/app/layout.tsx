import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import { JetBrains_Mono, Plus_Jakarta_Sans } from "next/font/google";
import "./globals.css";
import { ConfigProvider } from "@/components/providers/config-provider";
import { AppearanceProvider } from "@/components/providers/appearance-provider";
import {
	MODE_COOKIE,
	RESOLVED_COOKIE,
	THEME_COOKIE,
	ThemeMode,
	ThemeModeSchema,
	ThemeName,
	ThemeNameSchema,
} from "@schema/types/themes";
import { getPublicEnv } from "@schema";
import "@mantine/core/styles.css";
import "@mantine/dates/styles.css";
import {
	ColorSchemeScript,
	MantineProvider,
	mantineHtmlProps,
} from "@mantine/core";
import { createMantineTheme } from "@/lib/mantine-theme";
import { ModalsProvider } from "@mantine/modals";

const jakartaSans = Plus_Jakarta_Sans({
	variable: "--font-sans",
	subsets: ["latin"],
});
const jetbrains = JetBrains_Mono({
	variable: "--font-mono",
	subsets: ["latin"],
	// Only used on a few settings screens; don't preload it on every page.
	preload: false,
});

export const metadata: Metadata = {
	title: "Kurrier",
	description: "Mailbox, but nice.",
};

export const viewport: Viewport = {
	width: "device-width",
	initialScale: 1,
};

// In "system" mode the server cannot know the OS preference on the first
// visit (no resolved cookie yet). Resolve it before first paint so the page
// does not flash light -> dark while waiting for hydration.
const SYSTEM_MODE_SCRIPT = `try{var d=window.matchMedia("(prefers-color-scheme: dark)").matches,e=document.documentElement;e.classList.toggle("dark",d);e.style.colorScheme=d?"dark":"light"}catch(_){}`;

export default async function RootLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	const jar = await cookies();
	const theme: ThemeName = ThemeNameSchema.catch("indigo").parse(
		jar.get(THEME_COOKIE)?.value,
	);
	const mode: ThemeMode = ThemeModeSchema.catch("system").parse(
		jar.get(MODE_COOKIE)?.value,
	);

	const resolvedCookie = jar.get(RESOLVED_COOKIE)?.value;
	const resolved =
		resolvedCookie === "dark" || resolvedCookie === "light"
			? resolvedCookie
			: undefined;
	const initialDark =
		mode === "dark" ? true : mode === "light" ? false : resolved === "dark";

	const publicConfig = getPublicEnv();
	const { theme: mantineTheme, colorScheme } = createMantineTheme({
		theme,
		mode,
	});

	return (
		<html
			lang="en"
			data-theme={theme}
			className={`${initialDark ? "dark" : ""}`}
			{...mantineHtmlProps}
		>
			<head>
				<ColorSchemeScript
					defaultColorScheme={colorScheme}
					nonce="8IBTHwOdqNKAWeKl7plt8g=="
				/>
				{mode === "system" && (
					<script
						// biome-ignore lint/security/noDangerouslySetInnerHtml: static, inline pre-paint theme script
						dangerouslySetInnerHTML={{ __html: SYSTEM_MODE_SCRIPT }}
					/>
				)}
			</head>
			<body
				className={`${jakartaSans.variable} ${jetbrains.variable} font-sans bg-background text-foreground antialiased`}
			>
				<AppearanceProvider
					initialTheme={theme}
					initialMode={mode}
					initialResolved={resolved}
				>
					<ConfigProvider value={publicConfig}>
						<MantineProvider
							theme={mantineTheme}
							defaultColorScheme={colorScheme}
						>
							<ModalsProvider>{children}</ModalsProvider>
						</MantineProvider>
					</ConfigProvider>
				</AppearanceProvider>
			</body>
		</html>
	);
}
