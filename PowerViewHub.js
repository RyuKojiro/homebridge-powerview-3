var request = require('request');

let InitialRequestDelayMs = 100;
let RequestIntervalMs = 100;

let Position = {
	BOTTOM: 1,
	TOP: 2,
	VANES: 3
}
exports.Position = Position;


function PowerViewHub(log, host) {
	this.log = log;
	this.host = host;

	this.queue = [];
}
exports.PowerViewHub = PowerViewHub;

// Queue a shades API request.
PowerViewHub.prototype.queueRequest = function(queued) {
	if (!this.queue.length)
		this.scheduleRequest(InitialRequestDelayMs);

	this.queue.push(queued);
}

// Schedules a shades API PUT request.
PowerViewHub.prototype.scheduleRequest = function(delay) {
	setTimeout(function() {
		// Take the first queue item, and remove the data so that future requests don't try and modify it.
		// Leave an object in the queue though so queueRequest() doesnt schedule this method while the
		// request is in-flight, since we re-schedule ourselves if the queue has items.
		var queued = this.queue[0];
		this.queue[0] = {};

		var options = {
			url: "http://" + this.host + "/home/shades/" + queued.shadeId
		}
		
		if (queued.data) {
			options.method = 'PUT';
			options.json = { 'shade': queued.data };

			this.log("Put for", queued.shadeId, queued.data);
		}

		if (queued.qs) {
			options.qs = queued.qs;
		}

		request(options, function(err, response, body) {
			if (!err && response.statusCode == 200) {
				var json = queued.data ? body : JSON.parse(body);
				for (var callback of queued.callbacks) {
					callback(null, json.shade);
				}
			} else {
				if (!err)
					err = new Error("HTTP Error " + response.statusCode);
				this.log("Error setting position: %s", err);
				for (var callback of queued.callbacks) {
					callback(err);
				}
			}

			this.queue.shift();
			if (this.queue.length > 0) {
				this.scheduleRequest(RequestIntervalMs);
			}
		}.bind(this));
	}.bind(this), delay);
}


// Makes a userdata API request.
PowerViewHub.prototype.getUserData = function(callback) {
	request.get({
		url: "http://" + this.host + "/home/userdata"
	}, function(err, response, body) {
		if (!err && response.statusCode == 200) {
			var json = JSON.parse(body);

			if (callback) callback(null, json.userData);
		} else {
			if (!err)
				err = new Error("HTTP Error " + response.statusCode);
			this.log("Error getting userdata: %s", err);
			if (callback) callback(err);
		}
	}.bind(this));
}

// Makes a shades API request.
PowerViewHub.prototype.getShades = function(callback) {
	request.get({
		url: "http://" + this.host + "/home/shades"
	}, function(err, response, body) {
		if (!err && response.statusCode == 200) {
			var json = JSON.parse(body);

			if (callback) callback(null, json);
		} else {
			if (!err)
				err = new Error("HTTP Error " + response.statusCode);
			this.log("Error getting shades: %s", err);
			if (callback) callback(err);
		}
	}.bind(this));
}

// Makes a shades API request for a single shade.
PowerViewHub.prototype.getShade = function(shadeId, refresh = false, callback) {
	// Refresh is handled through queued requests, because the PowerView hub likes to
	// crash if we send too many of these at once.
	if (refresh) {
		for (var queued of this.queue) {
			if (queued.shadeId == shadeId && queued.qs) {
				queued.callbacks.push(callback);
				return;
			}
		}

		var queued = {
			'shadeId': shadeId,
			'qs': { 'refresh': 'true' },
			'callbacks': [callback]
		}
		this.queueRequest(queued);
		return;
	}

	request.get({
		url: "http://" + this.host + "/home/shades/" + shadeId
	}, function(err, response, body) {
		if (!err && response.statusCode == 200) {
			var json = JSON.parse(body);

			if (callback) callback(null, json.shade);
		} else {
			if (!err)
				err = new Error("HTTP Error " + response.statusCode);
			this.log("Error getting shade: %s", err);
			if (callback) callback(err);
		}
	}.bind(this));
}

// Makes a shades API request to change the position of a single shade.
// Requests are queued so only one is in flight at a time, and they are smart merged.
PowerViewHub.prototype.putShade = function(shadeId, position, value, userValue,callback) {
	for (var queued of this.queue) {
		if (queued.shadeId == shadeId && queued.data && queued.data.positions) {
			// Parse out the positions data back into a list of position to value.
			var positions = [];
			for (var i = 1; queued.data.positions['posKind'+i]; ++i) {
				positions[queued.data.positions['posKind'+i]] = queued.data.positions['position'+i];
			}

			// Set the new position.
			positions[position] = value;

			if (position == Position.VANES && userValue) {
				// Setting a non-zero vanes position overrides any bottom position since
				// this will close the shades.
				delete positions[Position.BOTTOM];
			} else if (position == Position.VANES && positions[Position.BOTTOM] != null) {
				// Otherwise don't set a zero vanes position if there's a bottom position.
				delete positions[Position.VANES];
			} else if (position == Position.BOTTOM && userValue) {
				// Setting a non-zero bottom position overrides any vanes position since
				// this will open the shades.
				delete positions[Position.VANES];
			} else if (position == Position.BOTTOM && positions[Position.VANES] != null) {
				// Otherwise don't set a zero bottom position if there's a vanes position.
				delete position[Position.BOTTOM];
			}

			// Reconstruct the data again, this places it back in position order.
			i = 1;
			queued.data.positions = {};
			for (var position in positions) {
				queued.data.positions['posKind'+i] = parseInt(position);
				queued.data.positions['position'+i] = positions[position];
				++i;
			}

			queued.callbacks.push(callback);
			return;
		}
	}

	var queued = {
		'shadeId': shadeId,
		'data': {
			'positions': {
				'posKind1': position,
				'position1': value
			}
		},
		'callbacks': [callback]
	}


	this.queueRequest(queued);
}

// Makes a shades API request to jog a shade.
PowerViewHub.prototype.jogShade = function(shadeId, callback) {
	for (var queued of this.queue) {
		if (queued.shadeId == shadeId && queued.data && queued.data.motion == 'jog') {
			queued.callbacks.push(callback);
			return;
		}
	}

	var queued = {
		'shadeId': shadeId,
		'data': { 'motion': 'jog' },
		'callbacks': [callback]
	}
	this.queueRequest(queued);
}

// Makes a shades API request to calibrate a shade.
PowerViewHub.prototype.calibrateShade = function(shadeId, callback) {
	for (var queued of this.queue) {
		if (queued.shadeId == shadeId && queued.data && queued.data.motion == 'calibrate') {
			queued.callbacks.push(callback);
			return;
		}
	}

	var queued = {
		'shadeId': shadeId,
		'data': { 'motion': 'calibrate' },
		'callbacks': [callback]
	}
	this.queueRequest(queued);
}
