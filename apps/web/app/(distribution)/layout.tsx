import type { Metadata } from "next";
import { JetBrains_Mono, Plus_Jakarta_Sans } from "next/font/google";
import { cookies } from "next/headers";
import {
    DISTRIBUTION_HEAD,
    DISTRIBUTION_METADATA,
} from "@distribution/metadata";

import "../globals.css";

import {getPublicEnv, WORKSPACE_THEME_COOKIE} from "@schema";
import {
    MODE_COOKIE,
    RESOLVED_COOKIE,
    THEME_COOKIE,
    type ThemeMode,
    ThemeModeSchema,
    type ThemeName,
    ThemeNameSchema,
} from "@schema/types/themes";

import { AppearanceProvider } from "@/components/providers/appearance-provider";
import { ConfigProvider } from "@/components/providers/config-provider";
import { SiteFeaturesProvider } from "@/components/providers/site-features-provider";

import "@mantine/core/styles.css";
import "@mantine/dates/styles.css";

import {
    ColorSchemeScript,
    MantineProvider,
    mantineHtmlProps,
} from "@mantine/core";
import { ModalsProvider } from "@mantine/modals";

import { createMantineTheme } from "@/lib/mantine-theme";
import { DISTRIBUTION_CONFIG } from "@distribution/config";

const jakartaSans = Plus_Jakarta_Sans({
    variable: "--font-sans",
    subsets: ["cyrillic-ext", "latin"],
});

const jetbrains = JetBrains_Mono({
    variable: "--font-mono",
    subsets: ["cyrillic", "latin"],
});

export const metadata: Metadata = DISTRIBUTION_METADATA;

// In "system" mode the server cannot know the OS preference on the first
// visit (no resolved cookie yet). Resolve it before first paint so the page
// does not flash light -> dark while waiting for hydration.
const SYSTEM_MODE_SCRIPT = `try{var d=window.matchMedia("(prefers-color-scheme: dark)").matches,e=document.documentElement,s=d?"dark":"light";e.classList.toggle("dark",d);e.style.colorScheme=s;e.setAttribute("data-mantine-color-scheme",s)}catch(_){}`;

export default async function DistributionLayout({
                                                     children,
                                                 }: {
    children: React.ReactNode;
}) {
    const jar = await cookies();

    const theme: ThemeName = ThemeNameSchema.catch("indigo").parse(
        jar.get(WORKSPACE_THEME_COOKIE)?.value ??
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
        mode === "dark"
            ? true
            : mode === "light"
                ? false
                : resolved === "dark";

    const publicConfig = getPublicEnv();

    const { theme: mantineTheme, colorScheme } = createMantineTheme({
        theme,
        mode,
    });

    return (
        <html
            lang={DISTRIBUTION_CONFIG.defaultLocale}
            data-theme={theme}
            className={initialDark ? "dark" : ""}
            {...mantineHtmlProps}
        >
        <head>
            <ColorSchemeScript defaultColorScheme={colorScheme} />
            {mode === "system" && (
                <script
                    // biome-ignore lint/security/noDangerouslySetInnerHtml: static, inline pre-paint theme script
                    dangerouslySetInnerHTML={{ __html: SYSTEM_MODE_SCRIPT }}
                />
            )}
            <DISTRIBUTION_HEAD />
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
                <SiteFeaturesProvider
                    value={DISTRIBUTION_CONFIG.features}
                >
                    <MantineProvider
                        theme={mantineTheme}
                        defaultColorScheme={colorScheme}
                    >
                        <ModalsProvider>
                            {children}
                        </ModalsProvider>
                    </MantineProvider>
                </SiteFeaturesProvider>
            </ConfigProvider>
        </AppearanceProvider>
        </body>
        </html>
    );
}
