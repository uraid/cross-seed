import ms from "ms";
import path, { extname } from "path";
import {
	EP_REGEX,
	PrefilterResult,
	SEASON_REGEX,
	VIDEO_EXTENSIONS,
} from "./constants.js";
import { db } from "./db.js";
import { getEnabledIndexers } from "./indexers.js";
import { Label, logger } from "./logger.js";
import { getRuntimeConfig } from "./runtimeConfig.js";
import { Searchee } from "./searchee.js";
import { humanReadable, nMsAgo } from "./utils.js";

function logReason(name: string, reason: string): void {
	logger.verbose({
		label: Label.PREFILTER,
		message: `Torrent ${name} was not selected for searching because ${reason}`,
	});
}

export function filterByContent(searchee: Searchee): PrefilterResult {
	const { includeEpisodes, includeNonVideos, includeSingleEpisodes } =
		getRuntimeConfig();

	const isSingleEpisodeTorrent =
		searchee.files.length === 1 && EP_REGEX.test(searchee.name);
	const isSeasonPackEpisode =
		searchee.path &&
		searchee.files.length === 1 &&
		SEASON_REGEX.test(path.basename(path.dirname(searchee.path)));

	if (
		!includeEpisodes &&
		!includeSingleEpisodes &&
		isSingleEpisodeTorrent &&
		!isSeasonPackEpisode
	) {
		return PrefilterResult.EXCLUDED_SINGLE_EPISODE;
	}

	if (includeSingleEpisodes && isSeasonPackEpisode) {
		return PrefilterResult.EXCLUDED_SEASON_PACK_EPISODE;
	}
	const allFilesAreVideos = searchee.files.every((file) =>
		VIDEO_EXTENSIONS.includes(extname(file.name))
	);

	if (!includeNonVideos && !allFilesAreVideos) {
		return PrefilterResult.EXCLUDED_NON_VIDEOS;
	}

	return PrefilterResult.INCLUDED;
}

export function filterAllByContent(searchees: Searchee[]): Searchee[] {
	const output: Searchee[] = [];
	const tally = {
		[PrefilterResult.EXCLUDED_NON_VIDEOS]: 0,
		[PrefilterResult.EXCLUDED_SINGLE_EPISODE]: 0,
		[PrefilterResult.EXCLUDED_SEASON_PACK_EPISODE]: 0,
	};

	const reasons = {
		[PrefilterResult.EXCLUDED_NON_VIDEOS]: "not all files are videos",
		[PrefilterResult.EXCLUDED_SINGLE_EPISODE]: "it is a single episode",
		[PrefilterResult.EXCLUDED_SEASON_PACK_EPISODE]:
			"it is a season pack episode",
	} as const;

	function logExclusionsOfType(prefilterResult: PrefilterResult): void {
		const count = tally[prefilterResult];
		if (count > 0) {
			logger.info({
				label: Label.PREFILTER,
				message: `Excluded ${count} torrents with reason: ${reasons[prefilterResult]}`,
			});
		}
	}

	for (const searchee of searchees) {
		const prefilterResult = filterByContent(searchee);
		if (prefilterResult === PrefilterResult.INCLUDED) {
			output.push(searchee);
		} else {
			logReason(searchee.name, reasons[prefilterResult]);
			tally[prefilterResult]++;
		}
	}
	logExclusionsOfType(PrefilterResult.EXCLUDED_SINGLE_EPISODE);
	logExclusionsOfType(PrefilterResult.EXCLUDED_SEASON_PACK_EPISODE);
	logExclusionsOfType(PrefilterResult.EXCLUDED_NON_VIDEOS);
	return output;
}

export function filterDupes(searchees: Searchee[]): Searchee[] {
	const duplicateMap = searchees.reduce((acc, cur) => {
		const entry = acc.get(cur.name);
		if (entry === undefined) {
			acc.set(cur.name, cur);
		} else if (cur.infoHash && !entry.infoHash) {
			acc.set(cur.name, cur);
		}
		return acc;
	}, new Map());

	const filtered = Array.from(duplicateMap.values());
	const numDupes = searchees.length - filtered.length;
	if (numDupes > 0) {
		logger.verbose({
			label: Label.PREFILTER,
			message: `${numDupes} duplicates not selected for searching`,
		});
	}
	return filtered;
}

export async function filterTimestamps(searchee: Searchee): Promise<boolean> {
	const { excludeOlder, excludeRecentSearch } = getRuntimeConfig();
	const enabledIndexers = await getEnabledIndexers();
	const timestampDataSql = await db("searchee")
		// @ts-expect-error crossJoin supports string
		.crossJoin("indexer")
		.leftOuterJoin("timestamp", {
			"timestamp.indexer_id": "indexer.id",
			"timestamp.searchee_id": "searchee.id",
		})
		.where("searchee.name", searchee.name)
		.whereIn(
			"indexer.id",
			enabledIndexers.map((i) => i.id)
		)
		.min({
			first_searched_any: db.raw(
				"coalesce(timestamp.first_searched, 9223372036854775807)"
			),
		})
		.min({
			last_searched_all: db.raw("coalesce(timestamp.last_searched, 0)"),
		})
		.first();

	const { first_searched_any, last_searched_all } = timestampDataSql;
	function logReason(reason) {
		logger.verbose({
			label: Label.PREFILTER,
			message: `Torrent ${searchee.name} was not selected for searching because ${reason}`,
		});
	}

	if (
		typeof excludeOlder === "number" &&
		first_searched_any &&
		first_searched_any < nMsAgo(excludeOlder)
	) {
		logReason(
			`its first search timestamp ${humanReadable(
				first_searched_any
			)} is older than ${ms(excludeOlder, { long: true })} ago`
		);
		return false;
	}

	if (
		typeof excludeRecentSearch === "number" &&
		last_searched_all &&
		last_searched_all > nMsAgo(excludeRecentSearch)
	) {
		logReason(
			`its last search timestamp ${humanReadable(
				last_searched_all
			)} is newer than ${ms(excludeRecentSearch, { long: true })} ago`
		);
		return false;
	}

	return true;
}
