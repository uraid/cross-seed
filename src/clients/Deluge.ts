import axios, { AxiosResponse } from "axios";
import { InjectionResult } from "../constants.js";
import { CrossSeedError } from "../errors.js";
import { Label, logger } from "../logger.js";
import { Metafile } from "../parseTorrent.js";
import { getRuntimeConfig } from "../runtimeConfig.js";
import { Searchee } from "../searchee.js";
import { TorrentClient } from "./TorrentClient.js";

export default class Deluge implements TorrentClient {
	private msgId = 0;
	private loggedIn = false;
	private delugeCookie = "";
	private delugeWebUrl: URL;
	private delugeLabel: string;
	private enLabeled: Promise<boolean>;

	constructor() {
		this.delugeWebUrl = new URL(`${getRuntimeConfig().delugeWebUrl}`);
		this.delugeLabel = getRuntimeConfig().dataCategory;
	}

	/**
	 * validates the login and host for deluge webui
	 */
	async validateConfig(): Promise<void> {
		const url = new URL(this.delugeWebUrl);
		if (url.username && !url.password) {
			throw new CrossSeedError(
				"you need to define a password in the delugeWebUrl. (eg: http://:<PASSWORD>@localhost:8112)"
			);
		}
		const result = await this.authenticate();
		if (!result) {
			logger.verbose({
				label: Label.DELUGE,
				message: "failed to authenticate the deluge daemon.",
			});
			throw new CrossSeedError(
				`failed to authenticate the deluge daemon.`
			);
		} else {
			this.enLabeled = this.labelEnabled();
		}
	}

	/**
	 * connects and authenticates to the webui
	 */
	private async authenticate(): Promise<boolean> {
		if (!this.loggedIn) {
			let response = await this.call({
				params: [this.delugeWebUrl.password],
				method: "auth.login",
			});
			if (response === null) {
				throw new CrossSeedError(
					`Could not reach deluge: ${this.delugeWebUrl.origin}`
				);
			}
			if (
				response &&
				response.headers &&
				response["data"]["result"] &&
				response.headers["set-cookie"]
			) {
				this.delugeCookie =
					response.headers["set-cookie"][0].split(";")[0];
				this.loggedIn = true;
			}
		} else {
			let response = await this.call({
				params: [this.delugeCookie],
				method: "auth.check_session",
			});
			this.loggedIn = !!response;
		}
		return this.loggedIn;
	}

	/**
	 * authenticates and sends JSON-RPC calls to deluge
	 */
	private async sendCall(method: string, params: any[]) {
		let response;
		if (!this.loggedIn) {
			await this.authenticate();
			response = await this.call({
				params,
				method,
			});
		} else
			response = await this.call({
				params: params,
				method,
			});

		return response && response.data && response.data.error === null
			? response.data
			: response.data.error;
	}

	private async call(body: any): Promise<AxiosResponse | null> {
		return new Promise((resolve) => {
			body.id = ++this.msgId;
			if (this.msgId > 1024) this.msgId = 0;
			axios
				.post(
					this.delugeWebUrl.origin + this.delugeWebUrl.pathname,
					body,
					{
						headers: {
							"Content-Type": "application/json",
							Cookie: this.delugeCookie,
						},
					}
				)
				.then((data) => {
					resolve(data);
				})
				.catch(() => resolve(null));
		});
	}

	/**
	 * lists plugins and adds/sets labels
	 * returns true if successful.
	 */
	private async labelEnabled() {
		const enabledLabels = await this.sendCall(
			"core.get_enabled_plugins",
			[]
		);
		return enabledLabels["result"].includes("Label");
	}
	private async setLabel(torrenthash: string) {
		if (this.enLabeled) {
			let setResult = await this.sendCall("label.set_torrent", [
				torrenthash,
				this.delugeLabel,
			]);
			if (
				setResult["message"] &&
				setResult["message"].includes("Unknown Label")
			) {
				await this.sendCall("label.add", [this.delugeLabel]);
				await this.sendCall("label.set_torrent", [
					torrenthash,
					this.delugeLabel,
				]);
			}
			return true;
		} else {
			return false;
		}
	}

	/**
	 * injects a torrent into deluge client
	 */
	async inject(
		newTorrent: Metafile,
		searchee: Searchee,
		path?: string
	): Promise<InjectionResult> {
		if (
			searchee.infoHash &&
			!(await this.checkCompleted(searchee.infoHash))
		) {
			return InjectionResult.TORRENT_NOT_COMPLETE;
		}
		const params = this.formatData(
			`${newTorrent.name}.cross-seed.torrent`,
			newTorrent.encode().toString("base64"),
			path
		);
		const addResult = await this.sendCall("core.add_torrent_file", params);
		if (addResult["result"]) {
			this.setLabel(newTorrent.infoHash);
			return InjectionResult.SUCCESS;
		}
		if (addResult["message"] && addResult["message"].includes("already")) {
			return InjectionResult.ALREADY_EXISTS;
		} else {
			logger.debug({
				label: Label.DELUGE,
				message: `injection failed: ${addResult["message"]}`,
			});
			return InjectionResult.FAILURE;
		}
	}

	/**
	 * formats the json for rpc calls to inject
	 */
	private formatData(filename: string, filedump: string, path: string) {
		return [
			filename,
			filedump,
			{
				file_priorities: [],
				add_paused: false,
				seed_mode: getRuntimeConfig().skipRecheck,
				compact_allocation: true,
				download_location: path,
				max_connections: -1,
				max_download_speed: -1,
				max_upload_slots: -1,
				max_upload_speed: -1,
				prioritize_first_last_pieces: false,
			},
		];
	}

	/**
	 * returns true if the torrent hash is Seeding (completed)
	 */
	async checkCompleted(infohash: string): Promise<boolean> {
		let params = [["name", "state", "save_path"], []];
		let response;
		try {
			let response = await this.sendCall("web.update_ui", params);
			if (
				response["result"]["torrents"][infohash]["state"] == "Seeding"
			) {
				return true;
			}
		} catch (e) {
			logger.debug({
				label: Label.DELUGE,
				message: `torrent state is not seeding. (state=${response["result"]["torrents"][infohash]["state"]})`,
			});
			return false;
		}
	}
}
