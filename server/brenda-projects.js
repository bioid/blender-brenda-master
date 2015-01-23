
module.exports = function() {
  var mkdirp = require('mkdirp');

  var BrendaProjects = function() {
    this.projects = {};
    this.update(function() {
      
    });
  };
  
  BrendaProjects.prototype.updateProjects = function(callback) {
    // Retrieves all of the projects in the database,
    // and adds them to this.projects
    global.dbHandler.getAllProjects(function(res) {
      for (var i = 0; i < res.rows.length; i++) {
        if (!this.projects.hasOwnProperty(res.rows[i].name)) {
          this.projects[res.rows[i].name] = res.rows[i];
        }
      }
      callback();
    }.bind(this));
  };
  
  BrendaProjects.prototype.updateJobs = function(callback) {
    global.dbHandler.getAllJobs(function(res) {
      for (var i = 0; i < res.rows.length; i++) {
        // loop through all of the jobs
        for (var key in this.projects) {
          // check each project to see if it has a foreign key
          // associated with this job
          if (this.projects.hasOwnProperty(key) && this.projects[key].project_id == res.rows[i].project_id) {
            if (!this.projects[key].hasOwnProperty('jobs')) { this.projects[key].jobs = {}; }
            // add the job to the project object
            this.projects[key].jobs[res.rows[i].job_id] = res.rows[i];
          }
        }
      }
      callback();
    }.bind(this));
  };

  BrendaProjects.prototype.update = function(callback) {
    // checks through the db and updates this.projects
    this.updateProjects(function() {
      this.updateJobs(function() {
        callback();
      }.bind(this)); 
    }.bind(this));
  };
  
  BrendaProjects.prototype.sanitizeString = function(str) {
    str = str.replace(/[^a-z0-9 \._-]/gim,"");
    return str.trim();
  };
  
  BrendaProjects.prototype.addProject = function(name, callback) {
    // sanitize the project name
    var sanitizedName = this.sanitizeString(name);
    // now add it to the db
    global.dbHandler.addProject(sanitizedName, function(res) {
      // next create the directory tree
      var pjpath = global.config.projects_dir + '/' + sanitizedName;
      this.update();
      mkdirp(pjpath + '/data', function(err) {
        if (err) { console.log('error making dir', err); }
        mkdirp(pjpath + '/jobs', function(err2) {
          if (err2) { console.log('error making dir', err2); }
          callback(sanitizedName);
        }.bind(this));
      }.bind(this));
    }.bind(this));
  };
  
  BrendaProjects.prototype.addJob = function(opts, callback) {
    // sanitize the jobname
    opts.jobname = this.sanitizeString(opts.jobname);
    global.dbHandler.addJob(opts, function(job_id) {
      callback(job_id);
    }.bind(this));
  };

  return new BrendaProjects();
};