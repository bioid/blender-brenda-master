module.exports = function(spawn, io) {
var mkdirp = require('mkdirp');
var fs = require('fs');
var glob = require('glob');

var Processes = function() {
  this.children = [];
  this.instances = {};
  this.db = false;
};

Processes.prototype.removeChild = function(child) {
  this.children.splice(this.children.indexOf(child), 1);
};

Processes.prototype.setDatabase = function(db) {
  this.db = db;
};

Processes.prototype.getBlenderFiles = function(project, callback) {
  var path = global.config.projects_dir + '/' + project.name + '/data/**/*.blend';
  glob(path, function(err, files) {
    if (err) { console.log(err) }
    callback(files);
  });
};

Processes.prototype.getRegionConfigs = function(callback) {
  var path = global.dirname + '/config/regions/**/*.conf';
  glob(path, function(err, files) {
    if (err) { console.log(err) }
    callback(files);
  });
};

Processes.prototype.buildConfig = function(opts, callback) {
  var configLines = [
    'WORK_QUEUE=sqs://elation-render-output',
    'BLENDER_PROJECT=s3://elation-render-data/'+ opts.project.name + '.tar.gz',
    'RENDER_OUTPUT=s3://elation-render-output/'+ opts.project.name + '/' + opts.jobname + '/',
    'BLENDER_FILE=' + opts.renderOpts.blenderFile,
    'BLENDER_RENDER_RESOLUTION_X=' + opts.renderOpts.renderResolutionX,
    'BLENDER_RENDER_RESOLUTION_Y=' + opts.renderOpts.renderResolutionY,
    'BLENDER_RENDER_RESOLUTION_PERCENTAGE=' + opts.renderOpts.renderPercentage,
    'BLENDER_CYCLES_SAMPLES=' + opts.renderOpts.samples,
    'BLENDER_CYCLES_DEVICE=' + opts.renderOpts.device
    ];

  if (opts.jobtype == "bake") {
    var baketype = opts.renderOpts.baketype = opts.baketype || 'COMBINED',
        bakemargin = opts.renderOpts.bakemargin = opts.bakemargin || 0,
        bakeuvlayer = opts.renderOpts.bakeuvlayer = opts.bakeuvlayer || 'LightMap';
    configLines.push('BLENDER_BAKE_TYPE=' + baketype);
    configLines.push('BLENDER_BAKE_MARGIN=' + bakemargin);
    configLines.push('BLENDER_BAKE_UVLAYER=' + bakeuvlayer);
  }

  var configText = configLines.join('\n') + '\n';
  var path = global.config.projects_dir + '/' + opts.project.name + '/jobs/' + opts.jobname + '/scratch/brenda-job.conf';
  fs.writeFile(path, configText, function(err) {
    if (err) { console.log(err) } 
    global.dbHandler.addBrendaConf(opts, function() {
      callback();
    })
  });
};

Processes.prototype.completeJob = function(client, opts, callback) {
  var path = global.dirname + '/scripts/brenda/job-complete.sh';
  var args = [opts.project.name, opts.job.job_name];
  var child = spawn(path, args);
  this.children.push(child);
  child.stdout.on('data', function(data) {
    console.log('stdout:', data.toString());
    client.emit('stdout', data.toString());
  });
  child.on('exit', function(code) {
    this.removeChild(child);
    global.dbHandler.setDone(opts.job.job_id, function() {
      callback();
    });
  }.bind(this));
};

Processes.prototype.submitJob = function(client, jobargs, callback) {
  var args = [];
  this.makeJobDir(jobargs.project.name, jobargs.jobname, function() {
    this.buildConfig(jobargs, function() {
      if (jobargs.jobtype == 'animation') {
        if (jobargs.subframe) {
          args = [jobargs.project.name, jobargs.jobname, 'subframe', '-s', jobargs.start, '-e', jobargs.end, '-X', jobargs.tilesX, '-Y', jobargs.tilesY];
        } else {
          args = [jobargs.project.name, jobargs.jobname, 'animation', '-s', jobargs.start, '-e', jobargs.end];
        }
      } else if (jobargs.jobtype == 'bake') {
        args = [jobargs.project.name, jobargs.jobname, 'bake', '-e', jobargs.numobjects];
      }
      var child = spawn(global.config.spawn_jobs, args); 
      this.children.push(child);
      child.stdout.on('data', function(data) {
        // emit stdout to the client who started this request
        console.log('stdout: ' + data);
        client.emit('stdout', data.toString());
      });
      child.on('exit', function(code) {
        this.checkJobCount();
        this.removeChild(child);
        callback();
      }.bind(this));
    }.bind(this));
  }.bind(this));
};

Processes.prototype.spawnInstance = function(client, instargs) {
  var args = ['-N', instargs.instancecount.num, '-i', instargs.instancetype, '-p', instargs.instanceprice];
  if (instargs.availabilityzone && instargs.availabilityzone.length > 0) {
    args = args.concat(['-z', instargs.availabilityzone]);
  }
  if (instargs.region && instargs.region.length > 0) {
    var regionConf = global.dirname + '/config/regions/' + instargs.region;
    args = args.concat(['-c', regionConf]);
  }
  if (instargs.dryrun) {
    args = args.concat(['-d']);
  }
  args.push('spot');

  var child = spawn(global.config.brenda_run, args);
  this.children.push(child);
  child.stdout.on('data', function(data) {
    console.log('stdout: ' + data);
    client.emit('stdout', data.toString());
  });
  child.stderr.on('data', function(data) {
    console.log('stderr: ' + data);
    client.emit('stdout', data.toString());
  });
  child.on('exit', function(code) {
    this.removeChild(child);
  }.bind(this));
};

Processes.prototype.buildJobFile = function(client, jobname) {
  var args = [global.config.jobdata_dir + jobname];
  console.log(args);
  var child = spawn(global.config.build_jobfile, args);
  this.children.push(child);
  child.stdout.on('data', function(data) {
    console.log('stdout: ' + data);
    io.sockets.connected[client].emit('stdout', data.toString());
  });
  child.on('exit', function(code) {
    this.removeChild(child);
  }.bind(this));
};

Processes.prototype.checkInstancePrice = function(client, instargs) {
  var args = ['-i', instargs.instancetype];
  if (instargs.region && instargs.region.length > 0) {
    var regionConf = global.dirname + '/config/regions/' + instargs.region;
    args = args.concat(['-c', regionConf]);
  }  
  args.push('price');
  var child = spawn('brenda-run', args);
  this.children.push(child);
  child.stdout.on('data', function(data) {
    console.log(data.toString());
    var lines = data.toString().split('\n');
    if (lines.length > 2) {
      var prices = {};
      for (var i=1; i < lines.length; i++) {
        var parts = lines[i].split(" ");
        if (parts.length > 0) {
          prices[parts[0]] = parts[2];
        }
      }
      client.emit('priceupdate', prices);
    }
    else {
      client.emit('priceupdate', 'No price info');
    }
  });
  child.on('exit', function(code) {
    this.removeChild(child);
  }.bind(this));
};
Processes.prototype.checkInstanceCounts = function() {
  if (!this.db) return;

  this.getRegionConfigs(function(files) {
    var regions = [];
    for (var i = 0; i < files.length; i++) {
      var parts = files[i].split('/');
      var regionconf = parts[parts.length - 1];
      this.checkInstanceCountForRegion(regionconf.substr(0, regionconf.indexOf('.')));
    }
    // Write the current instance counts into influxdb every 10 seconds
    setInterval(function() { this.db.writePoint('instances', this.instances); }.bind(this), 10000);
  }.bind(this));
};
Processes.prototype.checkInstanceCountForRegion = function(region) {
  if (!this.db) return;
  var args = []; //'-i', instargs.instancetype];
  if (region && region.length > 0) {
    var regionConf = global.dirname + '/config/regions/' + region + '.conf';
    args = args.concat(['-c', regionConf]);
  }
  args.push('instances');
  //console.log('Check instance count for region ' + region, args);
  var child = spawn('brenda-tool', args);
  this.children.push(child);

  var instancecount = 0;
  //this.instances[region] = 0;
  child.stdout.on('data', function(data) {
    var lines = data.toString().trim().split('\n');
    instancecount = lines.length;
  }.bind(this));
  child.on('exit', function(code) {
    this.instances[region] = instancecount;
    var influxcfg = global.config.influxdb;
    var refreshtime = (influxcfg && influxcfg.refresh && influxcfg.refresh.instances ? influxcfg.refresh.instances : 30000);
    setTimeout(this.checkInstanceCountForRegion.bind(this, region), refreshtime);
    this.removeChild(child);
  }.bind(this));
};
Processes.prototype.checkJobCount = function() {
  if (!this.db) return;
  var args = ['status'];
  //console.log('Check job count');
  var child = spawn('brenda-work', args);
  this.children.push(child);

  var jobcount = 0;
  //this.instances[region] = 0;
  child.stdout.on('data', function(data) {
    var lines = data.toString().trim().split(': ');
    jobcount = lines[1];
  }.bind(this));
  child.on('exit', function(code) {
    this.db.writePoint('jobs', {'jobs': jobcount});
    var influxcfg = global.config.influxdb;
    var refreshtime = (influxcfg && influxcfg.refresh && influxcfg.refresh.jobs ? influxcfg.refresh.jobs : 30000);
    setTimeout(this.checkJobCount.bind(this), refreshtime);
    this.removeChild(child);
  }.bind(this));
};

Processes.prototype.makeJobDir = function(projectDir, jobname, callback) {
  mkdirp(global.config.projects_dir + '/' + projectDir + '/jobs/' + jobname + '/' + 'scratch', function(err) {
    if (err) { console.log(err) }
    callback();
  });
};

Processes.prototype.killAll = function() {
  console.log('killing', this.children.length, 'child processes');
  this.children.forEach(function(child) {
    child.kill();
    this.removeChild(child);
  }.bind(this));
};

return new Processes();
};


