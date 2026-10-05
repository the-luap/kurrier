import { LoaderCircle } from "lucide-react";
import { cn } from "@/lib/utils";

const Loading = (props: {
	loadingClassNames?: string;
	wrapperClassNames?: string;
}) => {
	return (
		<div
			className={cn(
				"h-full min-h-screen flex justify-center items-center w-full",
				props.wrapperClassNames,
			)}
		>
			<LoaderCircle
				aria-hidden="true"
				className={cn(
					"animate-spin text-brand dark:text-brand-foreground w-8 h-8",
					props.loadingClassNames,
				)}
			/>
			<span className="sr-only">Loading…</span>
		</div>
	);
};

export default Loading;
