/* 
 * Copyright (C) 2015 Binux <roy@binux.me>
 *
 * This file is part of YAAW (https://github.com/binux/yaaw).
 *
 * YAAW is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Lesser General Public License as
 * published by the Free Software Foundation, either version 3 of
 * the License, or (at your option) any later version.
 *
 * YAAW is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.	See the
 * GNU Lesser General Public License for more details.
 *
 * You may get a copy of the GNU Lesser General Public License
 * from http://www.gnu.org/licenses/lgpl.txt
 *
 */

if (typeof ARIA2 == "undefined" || !ARIA2) var ARIA2 = (function() {
	var jsonrpc_interface, jsonrpc_protocol, jsonrpc_ws, interval_id, rpc_secret = null,
		unique_id = 0, ws_callback = {};
	var active_tasks_snapshot="", finished_tasks_list=undefined, tasks_cnt_snapshot="", select_lock=false, need_refresh=false;
	var auto_refresh = false;

	function get_error(result) {
		if (typeof result == "string")
			return result;
		else if (typeof result.error == "string")
			return result.error;
		else if (result.error && result.error.message)
			return result.error.message;
	}

	function default_error(result) {
		// console.debug(result);
		var error_msg = get_error(result);

		$("#main-alert .alert").attr("class", "alert alert-error");
		$("#main-alert .alert-msg").html("<strong>错误: </strong>"+error_msg);
		$("#main-alert").show();
	}

	function main_alert(_class, msg, timeout) {
		var msg_id = (new Date()).getTime();
		$("#main-alert .alert").attr("class", "alert "+_class);
		$("#main-alert .alert-msg").html(msg);
		$("#main-alert").data("msg_id", msg_id).show();
		if (timeout) {
			window.setTimeout(function() { 
				if($("#main-alert").data("msg_id") == msg_id) {
					$("#main-alert").fadeOut();
				}
			}, timeout);
		}
		return msg_id;
	}

	function bind_event(dom) {
		dom.find("[rel=tooltip]").tooltip({"placement": "bottom", "trigger" : "hover"});
	}

	function get_title(result) {
		var dir = result.dir;
		var title = "Unknown";
		if (result.bittorrent && result.bittorrent.info && result.bittorrent.info.name)
			title = result.bittorrent.info.name;
		else if (result.files[0].path && result.files[0].path.replace(
			new RegExp("^"+dir.replace(/\\/g, "/").replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')+"/?"), "").split("/").length) {
			title = result.files[0].path.replace(new RegExp("^"+dir.replace(/\\/g, "/").replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')+"/?"), "").split("/");
			if (result.bittorrent)
				title = title[0];
			else
				title = title[title.length-1];
		} else if (result.files.length && result.files[0].uris.length && result.files[0].uris[0].uri)
			title = result.files[0].uris[0].uri;

		if (result.files.length > 1) {
			var cnt = 0;
			for (var i=0; i<result.files.length; i++) {
				if (result.files[i].selected == "true")
					cnt += 1;
			}
			if (cnt > 1)
				title += " ("+cnt+ " files..)"
		}
		return title;
	}

	function request_auth(url) {
		return url.match(/^(?:(?![^:@]+:[^:@\/]*@)[^:\/?#.]+:)?(?:\/\/)?(?:([^:@]*(?::[^:@]*)?)?@)?/)[1];
	}

	function remove_auth(url) {
		return url.replace(/^((?![^:@]+:[^:@\/]*@)[^:\/?#.]+:)?(\/\/)?(?:(?:[^:@]*(?::[^:@]*)?)?@)?(.*)/, '$1$2$3');
	}

	return {
		init: function(path, onready) {
			var connect_msg_id = main_alert("alert-info", "正在连接...");
			$("#add-task-option-wrap").empty().append(YAAW.tpl.add_task_option({}));
			$("#aria2-gsetting").empty().append(YAAW.tpl.aria2_global_setting({}));

			jsonrpc_interface = path || "http://localhost:6800/jsonrpc";
			var auth_str = request_auth(jsonrpc_interface);
			if (auth_str && auth_str.indexOf('token:') == 0) {
				rpc_secret = auth_str;
				jsonrpc_interface = remove_auth(jsonrpc_interface);
			}

			if (jsonrpc_interface.indexOf("http") == 0) {
				jsonrpc_protocol = "http";
				$.jsonRPC.setup({endPoint: jsonrpc_interface, namespace: 'aria2'});
				ARIA2.request = ARIA2.request_http;
				ARIA2.batch_request = ARIA2.batch_request_http;
				if (onready) onready();
				if ($("#main-alert").data("msg_id") == connect_msg_id) {
					$("#main-alert").fadeOut();
				}
			} else if (jsonrpc_interface.indexOf("ws") == 0 && WebSocket) {
				jsonrpc_protocol = "ws"
				jsonrpc_ws = new WebSocket(jsonrpc_interface);
				jsonrpc_ws.onmessage = function(event) {
					var data = JSON.parse(event.data);
					// console.debug(data);
					if ($.isArray(data) && data.length) {
						var id = data[0].id;
						if (ws_callback[id]) {
							ws_callback[id].success(data);
							delete ws_callback[id];
						}
					} else {
						if (ws_callback[data.id]) {
							if (data.error)
								ws_callback[data.id].error(data);
							else
								ws_callback[data.id].success(data);
							delete ws_callback[data.id];
						};
					};
				};
				jsonrpc_ws.onerror = function(event) {
					// console.warn("error", event);
					main_alert("alert-error", "WebSocket 连接错误. 你可能需要刷新此页面.");
					ws_callback = {};
				};
				jsonrpc_ws.onopen = function() {
					ARIA2.request = ARIA2.request_ws;
					ARIA2.batch_request = ARIA2.batch_request_ws;
					if (onready) onready();
					if ($("#main-alert").data("msg_id") == connect_msg_id) {
						$("#main-alert").fadeOut();
					}
				};
			} else {
				main_alert("alert-error", "JSON-RPC Path错误, 只支持HTTP和WS协议");
			};
		},

		request: function(){},
		batch_request: function(){},

		request_http: function(method, params, success, error) {
			if (error == undefined)
				error = default_error;
			if (rpc_secret) {
				params = params || [];
				if (!$.isArray(params)) params = [params];
				params.unshift(rpc_secret);
			}
			$.jsonRPC.request(method, {params:params, success:success, error:error});
		},

		batch_request_http: function(method, params, success, error) {
			if (error == undefined)
				error = default_error;
			var commands = new Array();
			$.each(params, function(i, n) {
				n = n || [];
				if (!$.isArray(n)) n = [n];
				if (rpc_secret) {
					n.unshift(rpc_secret);
				}
				commands.push({method: method, params: n});
			});
			$.jsonRPC.batchRequest(commands, {success:success, error:error});
		},

		_request_data: function(method, params, id) {
			var dataObj = {
				jsonrpc: '2.0',
				method: 'aria2.'+method,
				id: id
			}
			if(typeof(params) !== 'undefined') {
				dataObj.params = params;
			}
			return dataObj;
		},

		_get_unique_id: function() {
			++unique_id;
			return unique_id;
		},

		request_ws: function(method, params, success, error) {
			var id = ARIA2._get_unique_id();
			ws_callback[id] = {
				'success': success || function(){},
				'error': error || default_error,
			};
			if (rpc_secret) {
				params = params || [];
				if (!$.isArray(params)) params = [params];
				params.unshift(rpc_secret);
			}
			jsonrpc_ws.send(JSON.stringify(ARIA2._request_data(method, params, id)));
		},

		batch_request_ws: function(method, params, success, error) {
			var data = [];
			var id = ARIA2._get_unique_id();
			ws_callback[id] = {
				'success': success || function(){},
				'error': error || default_error,
			};
			for (var i = 0, l = params.length; i < l; i++) {
				var n = params[i];
				n = n || [];
				if (!$.isArray(n)) n = [n];
				if (rpc_secret) {
					n.unshift(rpc_secret);
				}
				data.push(ARIA2._request_data(method, n, id))
			};
			jsonrpc_ws.send(JSON.stringify(data));
		},

		main_alert: main_alert,

		add_task: function(uri, options) {
			if (!uri) return false;
			if (!options) options = {};
			if (/^[0-9a-z]{40}$/i.test(uri)) {
				// console.debug('(add_task)Info Hash:' + uri);
				uri = 'magnet:?xt=urn:btih:' + uri;
			}
			ARIA2.request("addUri", [[uri], options],
				function(result) {
					// console.debug(result);
					ARIA2.refresh();
					$("#add-task-modal").modal('hide');
					YAAW.add_task.clean();
				}, 
				function(result) {
					// console.debug(result);
					var error_msg = get_error(result);

					$("#add-task-alert .alert-msg").text(error_msg);
					$("#add-task-alert").show();
					// console.warn("添加任务错误: "+error_msg);
				}
			);
		},

		madd_task: function(uris, options) {
			if (!$.isArray(uris)) uris = [uris];
			var params = [];
			for (var i=0; i<uris.length; i++) {
				uris[i] = $.trim(uris[i]);
				if (!uris[i]) continue;
				if (/^[0-9a-z]{40}$/i.test(uris[i])) {
					// console.debug('(madd_task)Info Hash:' + uris[i]);
					uris[i] = 'magnet:?xt=urn:btih:' + uris[i];
				}
				params.push([[uris[i]], options]);
			};
			ARIA2.batch_request("addUri", params,
				function(result) {
					// console.debug(result);
					var error = new Array();
					$.each(result, function(i, n) {
						var error_msg = get_error(n);
						if (error_msg) error.push(error_msg);
					});

					if (error.length == 0) {
						ARIA2.refresh();
						$("#add-task-modal").modal('hide');
						YAAW.add_task.clean();
					} else {
						var error_msg = error.join("<br />");
						$("#add-task-alert .alert-msg").html(error_msg);
						$("#add-task-alert").show();
						// console.warn("添加任务错误: "+error_msg);
					}
				}
			);
		},

		add_torrent: function(torrent, options) {
			if (!torrent) return false;
			if (!options) options = {};
			ARIA2.request("addTorrent", [torrent, [], options],
				function(result) {
					// console.debug(result);
					ARIA2.refresh();
					$("#add-task-modal").modal('hide');
					YAAW.add_task.clean();
				}, 
				function(result) {
					// console.debug(result);
					var error_msg = get_error(result);

					$("#add-task-alert .alert-msg").text(error_msg);
					$("#add-task-alert").show();
					// console.warn("添加任务错误: "+error_msg);
				}
			);
		},

		add_metalink: function(metalink, options) {
			if (!metalink) return false;
			if (!options) options = {};
			ARIA2.request("addMetalink", [metalink, [], options],
				function(result) {
					// console.debug(result);
					ARIA2.refresh();
					$("#add-task-modal").modal('hide');
					YAAW.add_task.clean();
				}, 
				function(result) {
					// console.debug(result);
					var error_msg = get_error(result);
					$("#add-task-alert .alert-msg").text(error_msg);
					$("#add-task-alert").show();
					// console.warn("添加任务错误: "+error_msg);
				}
			);
		},

		restart_task: function(gids) {
			if (!$.isArray(gids))
				gids = [gids];
			$.each(gids, function(n, gid) {
				var result = $("#task-gid-"+gid).data("raw");
				var uris = [];
				$.each(result.files, function(n, e) {
					if (e.uris.length)
						uris.push(e.uris[0].uri);
				});
				if (result.bittorrent) {
					var magnet_link = "magnet:?xt=urn:btih:" + result.infoHash;
					if (result.bittorrent.info.name)
						magnet_link += "&dn=" + result.bittorrent.info.name;
					if (result.bittorrent.announceList.length)
						magnet_link += "&tr=" + result.bittorrent.announceList.join("&tr=");
					uris.push(magnet_link);
				}
				if (uris.length > 0) {
					ARIA2.request("getOption", [gid], function(result) {
						var options = result.result;
						ARIA2.madd_task(uris, options);
						//delete old info(mostly failure).
						ARIA2.remove_result(gid);
					});
				}
			});
		},

		tell_active: function(keys) {
			if (select_lock) return;
			ARIA2.request("tellActive", keys,
				function(result) {
					// console.debug(result);
					if (select_lock) return;
					if (!result.result) {
						main_alert("alert-error", "<strong>错误: </strong>RPC 通信错误.", 5000);
					}

					var snapshot = new Array();
					$.each(result.result, function(i, e) {
						snapshot.push(e.gid);
					});
					if (snapshot.sort().join(",") != active_tasks_snapshot) {
						active_tasks_snapshot = snapshot.sort().join(",");
						need_refresh = true;
						if (auto_refresh && !select_lock)
							ARIA2.refresh();
					}
				
					result = ARIA2.status_fix(result.result);
					$("#active-tasks-table").empty().append(YAAW.tpl.active_task({"tasks": result}));
					$.each(result, function(n, e) {
						$("#task-gid-"+e.gid).data("raw", e);
					});
					bind_event($("#active-tasks-table"))
				}
			);
		},

		check_active_list: function() {
			ARIA2.request("tellActive", [["gid"]],
				function(result) {
					// console.debug(result);
					if (!result.result) {
						main_alert("alert-error", "<strong>错误: </strong>RPC 通信错误.", 5000);
					}

					var snapshot = new Array();
					$.each(result.result, function(i, e) {
						snapshot.push(e.gid);
					});
					if (snapshot.sort().join(",") != active_tasks_snapshot) {
						active_tasks_snapshot = snapshot.sort().join(",");
						need_refresh = true;
						if (auto_refresh && !select_lock)
							ARIA2.refresh();
					}
				}
			);
		},

		tell_waiting: function(keys) {
			if (select_lock) return;
			var params = [0, 1000];
			if (keys) params.push(keys);
			ARIA2.request("tellWaiting", params,
				function(result) {
					if (select_lock)
						return;
					if (!result.result) {
						main_alert("alert-error", "<strong>错误: </strong>RPC 通信错误.", 5000);
					}

					result = ARIA2.status_fix(result.result);
					$("#waiting-tasks-table").empty().append(YAAW.tpl.other_task({"tasks": result}));
					$.each(result, function(n, e) {
						$("#task-gid-"+e.gid).data("raw", e);
					});
					bind_event($("#waiting-tasks-table"))

					if ($("#other-tasks .task").length == 0)
						$("#waiting-tasks-table").append($("#other-task-empty").text())
				}
			);
		},

		tell_stopped: function(keys) {
			if (select_lock) return;
			var params = [0, 1000];
			if (keys) params.push(keys);
			ARIA2.request("tellStopped", params,
				function(result) {
					// console.debug(result);
					if (select_lock) return;
					if (!result.result) {
						main_alert("alert-error", "<strong>错误: </strong>RPC 通信错误.", 5000);
					}

					result = ARIA2.status_fix(result.result);

					if (finished_tasks_list === undefined) {
						finished_tasks_list = new Array();
						$.each(result, function(i, e) {
							if (e.status != "complete")
								return;
							finished_tasks_list.push(e.gid);
						});
					} else {
						$.each(result, function(i, e) {
							if (e.status != "complete")
								return;
							if (finished_tasks_list.indexOf(e.gid) != -1)
								return;
							if (ARIA2.finish_notification) {
								YAAW.notification("Aria2 Web 控制台通知", e.title + " 已完成");
							}
							finished_tasks_list.push(e.gid);
						});
					}

					$("#stopped-tasks-table").empty().append(YAAW.tpl.other_task({"tasks": result.reverse()}));
					$.each(result, function(n, e) {
						$("#task-gid-"+e.gid).data("raw", e);
					});
					bind_event($("#stopped-tasks-table"))

					if ($("#waiting-tasks-table .empty-tasks").length > 0 &&
						$("#stopped-tasks-table .task").length > 0) {
						$("#waiting-tasks-table").empty();
					}
				}
			);
		},

		status_fix: function(results) {
			for (var i=0; i<results.length; i++) {
				var result = results[i];

				result.title = get_title(result);
				if (result.totalLength == 0)
					result.progress = "0.00";
				else
					result.progress = (result.completedLength * 1.0 / result.totalLength * 100).toFixed(2);

				result.progressStatus = {
					"active": "progress-striped",
					"complete": "progress-success",
					"removed": "progress-warning",
					"error": "progress-danger"
				}[result.status];
				result.eta = (result.totalLength - result.completedLength)/result.downloadSpeed;
				result.downloadSpeed = parseInt(result.downloadSpeed);
				result.uploadSpeed = parseInt(result.uploadSpeed);
				result.uploadLength = parseInt(result.uploadLength);
				result.completedLength = parseInt(result.completedLength);
				result.numSeeders = parseInt(result.numSeeders);
				result.connections = parseInt(result.connections);
			}
			return results;
		},

		change_pos: function(gid, pos, how) {
			ARIA2.request("changePosition", [gid, pos, how],
				function(result) {
					// console.debug(result);
					main_alert("alert-info", "移动成功", 1000);
					ARIA2.refresh();
				}
			);
		},

		change_selected_pos: function(gids, pos, how) {
			var params = [];
			$.each(gids, function (i, n) {
				params.push([n, pos, how]);
			});
			ARIA2.batch_request("changePosition", params,
				function (result) {
					main_alert("alert-info", "移动成功", 1000);
					ARIA2.refresh();
				}
			);
		},

		pause: function(gids) {
			if (!$.isArray(gids)) gids = [gids];
			ARIA2.batch_request("pause", gids,
				function(result) {
					// console.debug(result);
					var error = new Array();
					$.each(result, function(i, n) {
						var error_msg = get_error(n);
						if (error_msg) error.push(error_msg);
					});

					if (error.length == 0) {
						main_alert("alert-info", "已暂停", 1000);
						ARIA2.refresh();
					} else {
						main_alert("alert-error", error.join("<br />"), 3000);
					}
				}
			);
		},

		unpause: function(gids) {
			if (!$.isArray(gids)) gids = [gids];
			ARIA2.batch_request("unpause", gids,
				function(result) {
					// console.debug(result);
					var error = new Array();
					$.each(result, function(i, n) {
						var error_msg = get_error(n);
						if (error_msg) error.push(error_msg);
					});

					if (error.length == 0) {
						main_alert("alert-info", "已开始", 1000);
						ARIA2.refresh();
					} else {
						main_alert("alert-error", error.join("<br />"), 3000);
					}
				}
			);
		},

		remove: function(gids) {
			if (!$.isArray(gids)) gids = [gids];
			ARIA2.batch_request("remove", gids,
				function(result) {
					// console.debug(result);
					var error = new Array();
					$.each(result, function(i, n) {
						var error_msg = get_error(n);
						if (error_msg) error.push(error_msg);
					});

					if (error.length == 0) {
						main_alert("alert-info", "已删除", 1000);
						ARIA2.refresh();
					} else {
						main_alert("alert-error", error.join("<br />"), 3000);
					}
				}
			);
		},

		remove_result: function(gids) {
			if (!$.isArray(gids)) gids = [gids];
			ARIA2.batch_request("removeDownloadResult", gids,
				function(result) {
					// console.debug(result);
					var error = new Array();
					$.each(result, function(i, n) {
						var error_msg = get_error(n);
						if (error_msg) error.push(error_msg);
					});

					if (error.length == 0) {
						main_alert("alert-info", "已删除", 1000);
						ARIA2.tell_stopped();
					} else {
						main_alert("alert-error", error.join("<br />"), 3000);
					}
				}
			);
		},

		get_options: function(gid) {
			ARIA2.request("getOption", [gid],
				function(result) {
					// console.debug(result);
					$("#ib-options").empty().append(YAAW.tpl.ib_options(result.result));
					if ($("#task-gid-"+gid).attr("data-status") == "active")
						$("#ib-options-form *[name]:not(.active-allowed)").attr("disabled", true);
				}
			);
		},

		change_options: function(gid, options) {
			ARIA2.request("changeOption", [gid, options],
				function(result) {
					// console.debug(result);
					main_alert("alert-info", "选项已更新", 1000);
				}
			);
		},

		get_peers: function(gid) {
			ARIA2.request("getPeers", [gid],
				function(result) {
					// console.debug(result);
					$('<tbody>').appendTo($('<table>').appendTo($("#ib-peers").empty()))
					.append('<tr><th>位置</th><th>客户端</th><th>完成率</th><th>下载速度</th><th>上传速度</th></tr>')
					.append(YAAW.tpl.ib_peers(result.result));
					//$("#ib-peers").empty().append(YAAW.tpl.ib_peers(result.result));
				}
			);
		},

		pause_all: function() {
			ARIA2.request("pauseAll", [],
				function(result) {
					// console.debug(result);
					ARIA2.refresh();
					main_alert("alert-info", "已暂停所有任务, 请等待 BitTorrent 服务器响应.", 2000);
				}
			);
		},

		unpause_all: function() {
			ARIA2.request("unpauseAll", [],
				function(result) {
					// console.debug(result);
					ARIA2.refresh();
					main_alert("alert-info", "取消暂停所有任务", 2000);
				}
			);
		},

		purge_download_result: function() {
			ARIA2.request("purgeDownloadResult", [],
				function(result) {
					// console.debug(result);
					ARIA2.refresh();
					main_alert("alert-info", "移除所有已完成/错误/已删除下载任务.", 2000);
				}
			);
		},

		get_global_option: function() {
			ARIA2.request("getGlobalOption", [],
				function(result) {
					if (!result.result)
						main_alert("alert-error", "<strong>错误: </strong>RPC 通信错误.", 5000);

					result = result.result;
					$("#aria2-gsetting").empty().append(YAAW.tpl.aria2_global_setting(result));
				}
			);
		},

		init_add_task_option: function() {
			ARIA2.request("getGlobalOption", [],
				function(result) {
					if (!result.result)
						main_alert("alert-error", "<strong>错误: </strong>RPC 通信错误.", 5000);

					result = result.result;
					result["parameterized-uri"] = (result["parameterized-uri"] == "true" ? true : false)
					$("#add-task-option-wrap").empty().append(YAAW.tpl.add_task_option(result));
				}
			);
		},

		change_global_option: function(options) {
			ARIA2.request("changeGlobalOption", [options],
				function(result) {
					if (!result.result)
						main_alert("alert-error", "<strong>错误: </strong>RPC 通信错误.", 5000);
					else
						main_alert("alert-success", "已保存", 2000);
				}
			);
		},

		global_stat: function() {
			ARIA2.request("getGlobalStat", [],
				function(result) {
					if (!result.result) {
						main_alert("alert-error", "<strong>错误: </strong>RPC 通信错误.", 5000);
					}

					result = result.result;
					var _tasks_cnt_snapshot = ""+result.numActive+","+result.numWaiting+","+result.numStopped;

					if (_tasks_cnt_snapshot != tasks_cnt_snapshot) {
						tasks_cnt_snapshot = _tasks_cnt_snapshot;
						need_refresh = true;
						if (auto_refresh && !select_lock)
							ARIA2.refresh();
					}

					$("#global-speed").empty().append(YAAW.tpl.global_speed(result));
					var title = "";
					if (result.downloadSpeed > 0) {
						 title += "↓" + YAAW.tpl.view.format_size_0()(result.downloadSpeed) + "/s ";
					}
					if (result.uploadSpeed > 0) {
						title += "↑" + YAAW.tpl.view.format_size_0()(result.uploadSpeed) + "/s ";
					}
					title += (title ? "- " : "") + "Aria2 Web 控制台";
					document.title = title;
				}
			);
		},

		get_version: function() {
			ARIA2.request("getVersion", [],
				function(result) {
					if (!result.result) {
						main_alert("alert-error", "<strong>错误: </strong>RPC 通信错误.", 5000);
					}

					$("#global-version").text("Aria2 "+result.result.version || "");
				}
			);
		},

		get_status: function(gid) {
			ARIA2.request("tellStatus", [gid],
				function(result) {
					if (!result.result) {
						main_alert("alert-error", "<strong>错误: </strong>RPC 通信错误.", 5000);
					}

					result = result.result;
					result.uris = [];
					for (var i = 0; i < result.files.length; i++) {
						var file = result.files[i];
						file.title = file.path.replace(new RegExp("^"+result.dir.replace(/\\/g, "[\\/]")+"/?"), "");
						file.selected = file.selected == "true" ? true : false;
						file.progress = (file.completedLength * 1.0 / file.length * 100).toFixed(2);
						if (file.uris && file.uris.length) {
							for (var j = 0; j < file.uris.length; j++) {
								var uri = file.uris[j].uri;
								if (result.uris.indexOf(uri) == -1) {
									result.uris.push(uri);
								}
							}
						}
					};
					$("#ib-status").empty().append(YAAW.tpl.ib_status(result));
					$("#ib-files .file-list").empty().append(YAAW.tpl.files_tree(result.files));
					if ($("#task-gid-" + gid).attr("data-status") != "paused")
						$("#ib-file-save").hide();
					if (result.bittorrent) {
						$("#ib-peers-a").show();
					}
				}
			);
		},

		change_option: function(gid, options) {
			ARIA2.request("changeOption", [gid, options],
				function(result) {
					if (!result.result) {
						main_alert("alert-error", "<strong>错误: </strong>RPC 通信错误.", 5000);
					} else {
						main_alert("alert-success", "选项更改成功!", 2000);
					}
				}
			);
		},

		/********************************************************/

		refresh: function() {
			if (!select_lock) {
				need_refresh = false;
				ARIA2.tell_active();
				ARIA2.tell_waiting();
				ARIA2.tell_stopped();
			}
		},

		select_lock: function (bool) {
			select_lock = bool;
		},

		auto_refresh: function(interval) {
			if (interval_id)
				window.clearInterval(interval_id);
			if (interval < 1000) {
				auto_refresh = false;
				return ;
			}
			interval_id = window.setInterval(function() {
				ARIA2.global_stat();
				if (select_lock) {
					if (need_refresh) {
						main_alert("", "任务列表已经改变。点击“刷新”按钮来更新任务列表。");
					}
				} else {
					if (need_refresh) {
						ARIA2.refresh();
					} else {
						ARIA2.tell_active();
					}
				}
			}, interval);
			auto_refresh = true;
		},

		finish_notification: 1,
	}
})();
