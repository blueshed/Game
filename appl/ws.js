import Promise from "bluebird";


export default function(vm, ws_url){

	Promise.onPossiblyUnhandledRejection(function(error){
	    vm.error = error;
	});

	var buffer = [];
	var last_request_id = 1;
	var requests = {};

	vm.$set("connected",false);

	var ws = new WebSocket(ws_url);

	ws.rpc = (method, args) => {
		var request_id = last_request_id += 1;
		return new Promise((resolve, reject)=>{
			if(resolve) requests[request_id] = { success: resolve, error: reject };
			var msg = JSON.stringify({
				request_id: request_id,
				method: method,
				args: args || {}
			});
			if(vm.connected){
				ws.send(msg);
			} else {
				buffer.push(msg);
			}
		});
	};

	ws.onopen = () => {
		vm.connected = true;
		buffer.forEach((msg)=>{
			ws.send(msg);
		});
	};

	ws.onmessage = (evt) => {
		var data = JSON.parse(evt.data);
		var message = JSON.stringify(data,null,4);
		if(data.response_id) {
			if(data.error) requests[data.response_id].error(new Error(data.error));
			else requests[data.response_id].success(data.result);
			delete requests[data.response_id]
		} else {
			vm.$emit(data.signal, data.message);
		}
	};

	ws.onclose = () => {
		vm.connected = false;
	}

	return ws;
}
