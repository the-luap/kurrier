"use client";
import React, { useEffect, useRef, useState } from "react";
import { ComboboxItem, TagsInput, TagsInputProps } from "@mantine/core";
import ContactSuggestionItem from "@/components/mailbox/default/editor/contact-suggestion-item";
import { searchContactsForCompose } from "@/lib/actions/calendar";

export default function SearchableContacts({
	onChange,
}: {
	onChange?: (value: string, contact: ComboboxItem | undefined) => void;
}) {
	const [searchValue, setSearchValue] = useState("");
	const [options, setOptions] = useState<ComboboxItem[]>([]);

	const [searchableContacts, setSearchableContacts] = useState<string[]>([]);

	// Debounce the server action and ignore out-of-order responses: previously
	// every keystroke fired a request and a slow earlier response could
	// overwrite the results of a later query.
	const requestIdRef = useRef(0);
	const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(
		() => () => {
			if (debounceRef.current) clearTimeout(debounceRef.current);
		},
		[],
	);

	const runSearch = async (val: string, requestId: number) => {
		const rows = await searchContactsForCompose(val);
		if (requestId !== requestIdRef.current) return;

		const seen = new Set<string>();
		const mapped: ComboboxItem[] = rows
			.map((row) => ({
				value: row.id,
				row: row,
				label: `${row.email}`,
				name: row.name,
				avatar: row.avatar,
			}))
			.filter((item) => {
				if (seen.has(item.value)) return false;
				seen.add(item.value);
				return true;
			});

		setOptions(mapped);
	};

	const searchContacts = (val: string) => {
		setSearchValue(val);
		const requestId = ++requestIdRef.current;
		if (debounceRef.current) clearTimeout(debounceRef.current);
		debounceRef.current = setTimeout(() => {
			void runSearch(val, requestId);
		}, 200);
	};

	const renderOption: TagsInputProps["renderOption"] = ({ option }) => (
		<ContactSuggestionItem option={option} />
	);

	return (
		<>
			<TagsInput
				searchValue={searchValue}
				onSearchChange={searchContacts}
				data={options}
				value={searchableContacts}
				onOptionSubmit={(val) => {
					const contact = options.find((o) => o.value === val);
					onChange && onChange(val, contact);
				}}
				onChange={(value) => {
					if (value.length > 0) {
						setSearchableContacts([]);
					}
				}}
				renderOption={renderOption}
				size="sm"
				className="min-h-[28px] text-sm max-w-md"
				comboboxProps={{
					dropdownPadding: 0,
					withinPortal: false,
					position: "bottom-start",
					offset: 1,
					width: "target",
					shadow: "0 4px 6px rgba(0, 0, 0, 0.1)",
					transitionProps: { transition: "skew-down", duration: 150 },
				}}
			/>
		</>
	);
}
