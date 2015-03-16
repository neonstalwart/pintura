/**
 * Registers message/json media handler. This is used for sending and receiving multiple
 * requests/responses/messages, and is very useful for bulk updates and Comet
 */
var JSONExt = require("perstore/util/json-ext"),
	Media = require("../../media").Media,
	all = require("promised-io/promise").all,
	when = require("promised-io/promise").when,
	serializeJson = require("../json").StreamingSerializer(JSON.stringify),
	Broadcaster = require("tunguska/jsgi/comet").Broadcaster,
	getClientConnection =  require("tunguska/jsgi/comet").getClientConnection,
	forEachableToString = require("../../media").forEachableToString;

module.exports = Media({
	mediaType:"message/json",
	getQuality: function(object){
		return 0.75;
	},
	deserialize: function(body, parameters, request){
		body = when(forEachableToString(body), function(body){
			if(!body){
				body = "[]";
			}
			return JSONExt.parse(body);
		});
		// release the buffer backing request.body
		request.body = null;
		return {
			callNextApp: function(nextApp){
				return when(body, function(body){
					if(!(body instanceof Array)){
						body = [body];
					}
					var responses = [];
					var clientConnection = getClientConnection(request);
					body.forEach(function(message){
						var response;

						if (!message) {
							response = {
								headers: {},
								status: 400,
								body: []
							};
							message = {};
						}
						else {
							message.__proto__ = request;
							var headers = message.headers;
							if (headers) {
								message.headers = Object.create(request.headers);
								for (var h in headers) {
									message.headers[h] = headers[h];
								}
							}
							if(!("to" in message)){
								message.to = "";
							}
							var pathInfo = message.to.charAt(0) === '/' ? message.to : request.pathInfo.substring(0, request.pathInfo.lastIndexOf('/') + 1) + message.to;
							while(lastPath !== pathInfo){
								var lastPath = pathInfo;
								pathInfo = pathInfo.replace(/\/[^\/]*\/\.\.\//,'/');
							}
							message.pathInfo = pathInfo;
							response = nextApp(message);
						}

						var id = message.id;
						message = null;
						responses.push(response);
						when(response, function(response){
							response.pathInfo = pathInfo;
							response.id = id;
							if(response.body && typeof response.body.observe === "function"){
								var subscription = response.body;
								subscription.observe(function(message){
									message.from = pathInfo;
									message.id = id;
									clientConnection.send(message);
								});
								clientConnection.observe("close", subscription.unsubscribe);
							}
						});
					});
					return when(all(responses), function(responses){
						var body = responses.filter(function(response){
							//ignore the observable messages since they indicate that we should keep the connection open and wait for the real message
							return !(response.body && typeof response.body.observe === "function");
						});

						return {
							status: body.length !== responses.length ? 202: 200,
							headers: {},
							messages: true,
							body: body
						};
					});
				});
			}
		};
	},
	serialize: function(body, parameters, request, response){
		var connectionResponse = Broadcaster(function(){
			var clientConnection = getClientConnection(request);
			if(response.messages){
				body.forEach(function(value){
					clientConnection.push({
						from: value.pathInfo,
						id: value.id,
						metadata: value.headers,
						error: value.status >= 400 ? value.status : undefined,
						body: value.body,
						status: value.status
					});
				});
			}else{
				clientConnection.push(response);
			}
		})(request);

		response.onClose = connectionResponse.onClose;

		return serializeJson(connectionResponse.body, parameters, request);
	}
});
