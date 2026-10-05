"use client";

import { Toaster as Sonner, ToasterProps } from "sonner";

// The app has no next-themes provider; callers pass `theme` explicitly
// (see AppearanceProvider), so default to "system".
const Toaster = ({ theme = "system", ...props }: ToasterProps) => {
	return (
		<Sonner
			theme={theme}
			className="toaster group"
			style={
				{
					"--normal-bg": "var(--popover)",
					"--normal-text": "var(--popover-foreground)",
					"--normal-border": "var(--border)",
				} as React.CSSProperties
			}
			{...props}
		/>
	);
};

export { Toaster };
