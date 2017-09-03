var basal = require('oref0/lib/profile/basal');
var get_iob = require('oref0/lib/iob');
var find_insulin = require('oref0/lib/iob/history');
var isf = require('../profile/isf');
var find_meals = require('oref0/lib/meal/history');
var tz = require('moment-timezone');

function detectSensitivityandCarbAbsorption(inputs) {

    glucose_data = inputs.glucose_data.map(function prepGlucose (obj) {
        //Support the NS sgv field to avoid having to convert in a custom way
        obj.glucose = obj.glucose || obj.sgv;
        return obj;
    });
    iob_inputs = inputs.iob_inputs;
    basalprofile = inputs.basalprofile;
    profile = inputs.iob_inputs.profile;

    // use last 24h worth of data by default
    var lastSiteChange = new Date(new Date().getTime() - (24 * 60 * 60 * 1000));
    if (inputs.iob_inputs.profile.rewind_resets_autosens ) {
        // scan through pumphistory and set lastSiteChange to the time of the last pump rewind event
        // if not present, leave lastSiteChange unchanged at 24h ago.
        var history = inputs.iob_inputs.history;
        for (var h=1; h < history.length; ++h) {
            if ( ! history[h]._type || history[h]._type != "Rewind" ) {
                //process.stderr.write("-");
                continue;
            }
            if ( history[h].timestamp ) {
                lastSiteChange = new Date( history[h].timestamp );
                console.error("Setting lastSiteChange to",lastSiteChange,"using timestamp",history[h].timestamp);
                break;
            }
        }
    }

    // get treatments from pumphistory once, not every time we get_iob()
    var treatments = find_insulin(inputs.iob_inputs);

    var mealinputs = {
        history: inputs.iob_inputs.history
    , profile: profile
    , carbs: inputs.carbs
    , glucose: inputs.glucose_data
    //, prepped_glucose: prepped_glucose_data
    };
    var meals = find_meals(mealinputs);
    meals.sort(function (a, b) {
        var aDate = new Date(tz(a.timestamp));
        var bDate = new Date(tz(b.timestamp));
        //console.error(aDate);
        return bDate.getTime() - aDate.getTime();
    });
    //console.error(meals);

    var avgDeltas = [];
    var bgis = [];
    var deviations = [];
    var deviationSum = 0;
    var bucketed_data = [];
    glucose_data.reverse();
    bucketed_data[0] = glucose_data[0];
    j=0;
    // go through the meal treatments and remove any that are older than the oldest glucose value
    //console.error(meals);
    for (var i=meals.length-1; i>0; --i) {
        var treatment = meals[i];
        //console.error(treatment);
        if (treatment) {
            var treatmentDate = new Date(tz(treatment.timestamp));
            var treatmentTime = treatmentDate.getTime();
            var glucoseDatum = bucketed_data[bucketed_data.length-1];
            //console.error(glucoseDatum);
            var BGDate = new Date(glucoseDatum.date);
            var BGTime = BGDate.getTime();
            if ( treatmentTime < BGTime ) {
                //console.error("Removing old meal: ",treatmentDate);
                meals.splice(i,1);
            }
        }
    }
    for (var i=1; i < glucose_data.length; ++i) {
        var bgTime;
        var lastbgTime;
        if (glucose_data[i].display_time) {
            bgTime = new Date(glucose_data[i].display_time.replace('T', ' '));
        } else if (glucose_data[i].dateString) {
            bgTime = new Date(glucose_data[i].dateString);
        } else { console.error("Could not determine BG time"); }
        if (bucketed_data[0].display_time) {
            lastbgTime = new Date(bucketed_data[0].display_time.replace('T', ' '));
        } else if (glucose_data[i-1].display_time) {
            lastbgTime = new Date(glucose_data[i-1].display_time.replace('T', ' '));
        } else if (glucose_data[i-1].dateString) {
            lastbgTime = new Date(glucose_data[i-1].dateString);
        } else { console.error("Could not determine last BG time"); }
        if (glucose_data[i].glucose < 39 || glucose_data[i-1].glucose < 39) {
//console.error("skipping:",glucose_data[i].glucose,glucose_data[i-1].glucose);
            continue;
        }
        // only consider BGs since lastSiteChange
        if (lastSiteChange) {
            hoursSinceSiteChange = (bgTime-lastSiteChange)/(60*60*1000);
            if (hoursSinceSiteChange < 0) {
                continue;
            }
        }
        var elapsed_minutes = (bgTime - lastbgTime)/(60*1000);
        if(Math.abs(elapsed_minutes) > 2) {
            j++;
            bucketed_data[j]=glucose_data[i];
            bucketed_data[j].date = bgTime.getTime();
        } else {
            bucketed_data[j].glucose = (bucketed_data[j].glucose + glucose_data[i].glucose)/2;
        }
    }
    var absorbing = 0;
    var uam = 0; // unannounced meal
    var mealCOB = 0;
    var mealCarbs = 0;
    var type="";
    //console.error(bucketed_data);
    for (var i=3; i < bucketed_data.length; ++i) {
        var bgTime = new Date(bucketed_data[i].date);

        var sens = isf.isfLookup(profile.isfProfile,bgTime);

        //console.error(bgTime , bucketed_data[i].glucose);
        var bg;
        var avgDelta;
        var delta;
        if (typeof(bucketed_data[i].glucose) != 'undefined') {
            bg = bucketed_data[i].glucose;
            if ( bg < 40 || bucketed_data[i-3].glucose < 40) {
                process.stderr.write("!");
                continue;
            }
            avgDelta = (bg - bucketed_data[i-3].glucose)/3;
            delta = (bg - bucketed_data[i-1].glucose);
        } else { console.error("Could not find glucose data"); }

        avgDelta = avgDelta.toFixed(2);
        iob_inputs.clock=bgTime;
        iob_inputs.profile.current_basal = basal.basalLookup(basalprofile, bgTime);
        //console.log(JSON.stringify(iob_inputs.profile));
        //console.error("Before: ", new Date().getTime());
        var iob = get_iob(iob_inputs, true, treatments)[0];
        //console.error("After: ", new Date().getTime());
        //console.log(JSON.stringify(iob));

        var bgi = Math.round(( -iob.activity * sens * 5 )*100)/100;
        bgi = bgi.toFixed(2);
        //console.error(delta);
        deviation = delta-bgi;
        deviation = deviation.toFixed(2);

        var glucoseDatum = bucketed_data[i];
        //console.error(glucoseDatum);
        var BGDate = new Date(glucoseDatum.date);
        var BGTime = BGDate.getTime();
        // As we're processing each data point, go through the treatment.carbs and see if any of them are older than
        // the current BG data point.  If so, add those carbs to COB.
        var treatment = meals[meals.length-1];
        if (treatment) {
            var treatmentDate = new Date(tz(treatment.timestamp));
            var treatmentTime = treatmentDate.getTime();
            if ( treatmentTime < BGTime ) {
                if (treatment.carbs >= 1) {
            //console.error(treatmentDate);
                    mealCOB += parseFloat(treatment.carbs);
                    mealCarbs += parseFloat(treatment.carbs);
                    displayCOB = Math.round(mealCOB);
                    process.stderr.write(displayCOB.toString());
                }
                meals.pop();
            }
        }

        // calculate carb absorption for that 5m interval using the deviation.
        if ( mealCOB > 0 ) {
            //var profile = profileData;
            ci = Math.max(deviation, profile.min_5m_carbimpact);
            absorbed = ci * profile.carb_ratio / sens;
            mealCOB = Math.max(0, mealCOB-absorbed);
        }
        // Store the COB, and use it as the starting point for the next data point.

        // If mealCOB is zero but all deviations since hitting COB=0 are positive, assign those data points to CSFGlucoseData
        // Once deviations go negative for at least one data point after COB=0, we can use the rest of the data to tune ISF or basals
        if (mealCOB > 0 || absorbing || mealCarbs > 0) {
            if (deviation > 0) {
                absorbing = 1;
            } else {
                absorbing = 0;
            }
            if ( ! absorbing && ! mealCOB ) {
                mealCarbs = 0;
            }
            // check previous "type" value, and if it wasn't csf, set a mealAbsorption start flag
            //console.error(type);
            if ( type != "csf" ) {
                process.stderr.write("g(");
                //glucoseDatum.mealAbsorption = "start";
                //console.error(glucoseDatum.mealAbsorption,"carb absorption");
            }
            type="csf";
            glucoseDatum.mealCarbs = mealCarbs;
            //if (i == 0) { glucoseDatum.mealAbsorption = "end"; }
            //CSFGlucoseData.push(glucoseDatum);
        } else {
          // check previous "type" value, and if it was csf, set a mealAbsorption end flag
          if ( type === "csf" ) {
            process.stderr.write(")");
            //CSFGlucoseData[CSFGlucoseData.length-1].mealAbsorption = "end";
            //console.error(CSFGlucoseData[CSFGlucoseData.length-1].mealAbsorption,"carb absorption");
          }

          currentBasal = iob_inputs.profile.current_basal;
          if (iob.iob > currentBasal || uam) {
            if (deviation > 0) {
                uam = 1;
            } else {
                uam = 0;
            }
            if ( type != "uam" ) {
                process.stderr.write("u(");
                //glucoseDatum.uamAbsorption = "start";
                //console.error(glucoseDatum.uamAbsorption,"uannnounced meal absorption");
            }
            type="uam";
          } else {
            if ( type === "uam" ) {
                process.stderr.write(")");
                //console.error("end unannounced meal absorption");
            }
            type = "non-meal"
          }
        }

        // Exclude meal-related deviations (carb absorption) from autosens
        if (type === "non-meal" && avgDelta-bgi < 6) {
            if ( deviation > 0 ) {
                process.stderr.write("+");
            } else if ( deviation == 0 ) {
                process.stderr.write("=");
            } else {
                process.stderr.write("-");
            }
            avgDeltas.push(avgDelta);
            bgis.push(bgi);
            deviations.push(deviation);
            deviationSum += parseFloat(deviation);
        } else {
            process.stderr.write(">");
            //console.error(bgTime);
        }
    }
    //console.error("");
    process.stderr.write(" ");
    //console.log(JSON.stringify(avgDeltas));
    //console.log(JSON.stringify(bgis));
    // when we have less than 12h worth of deviation data, add up to 1h of zero deviations
    // this dampens any large sensitivity changes detected based on too little data, without ignoring them completely
    if (deviations.length < 144) {
        pad = Math.round((1 - deviations.length/144) * 12);
        console.error("Found",deviations.length,"deviations since",lastSiteChange,"- adding",pad,"more zero deviations");
        for (var d=0; d<pad; d++) {
            //process.stderr.write(".");
            deviations.push(0);
        }
    }
    avgDeltas.sort(function(a, b){return a-b});
    bgis.sort(function(a, b){return a-b});
    deviations.sort(function(a, b){return a-b});
    for (var i=0.9; i > 0.1; i = i - 0.02) {
        //console.error("p="+i.toFixed(2)+": "+percentile(avgDeltas, i).toFixed(2)+", "+percentile(bgis, i).toFixed(2)+", "+percentile(deviations, i).toFixed(2));
        if ( percentile(deviations, (i+0.02)) >= 0 && percentile(deviations, i) < 0 ) {
            //console.error("p="+i.toFixed(2)+": "+percentile(avgDeltas, i).toFixed(2)+", "+percentile(bgis, i).toFixed(2)+", "+percentile(deviations, i).toFixed(2));
            console.error(Math.round(100*i)+"% of non-meal deviations <= 0 (target 45%-50%)");
        }
    }
    pSensitive = percentile(deviations, 0.50);
    pResistant = percentile(deviations, 0.45);

    average = deviationSum / deviations.length;

    //console.error("Mean deviation: "+average.toFixed(2));
    var basalOff = 0;

    if(pSensitive < 0) { // sensitive
        basalOff = pSensitive * (60/5) / profile.sens;
        process.stderr.write("Excess insulin sensitivity detected: ");
    } else if (pResistant > 0) { // resistant
        basalOff = pResistant * (60/5) / profile.sens;
        process.stderr.write("Excess insulin resistance detected: ");
    } else {
        console.error("Sensitivity normal.");
    }
    ratio = 1 + (basalOff / profile.max_daily_basal);

    // don't adjust more than 1.2x by default (set in preferences.json)
    var rawRatio = ratio;
    ratio = Math.max(ratio, profile.autosens_min);
    ratio = Math.min(ratio, profile.autosens_max);

    if (ratio !== rawRatio) {
      console.error('Ratio limited from ' + rawRatio + ' to ' + ratio);
    }

    ratio = Math.round(ratio*100)/100;
    newisf = Math.round(profile.sens / ratio);
    if (ratio != 1) { console.error("ISF adjusted from "+profile.sens+" to "+newisf); }
    //console.error("Basal adjustment "+basalOff.toFixed(2)+"U/hr");
    //console.error("Ratio: "+ratio*100+"%: new ISF: "+newisf.toFixed(1)+"mg/dL/U");
    var output = {
        "ratio": ratio
    }
    return output;
}
module.exports = detectSensitivityandCarbAbsorption;

// From https://gist.github.com/IceCreamYou/6ffa1b18c4c8f6aeaad2
// Returns the value at a given percentile in a sorted numeric array.
// "Linear interpolation between closest ranks" method
function percentile(arr, p) {
    if (arr.length === 0) return 0;
    if (typeof p !== 'number') throw new TypeError('p must be a number');
    if (p <= 0) return arr[0];
    if (p >= 1) return arr[arr.length - 1];

    var index = arr.length * p,
        lower = Math.floor(index),
        upper = lower + 1,
        weight = index % 1;

    if (upper >= arr.length) return arr[lower];
    return arr[lower] * (1 - weight) + arr[upper] * weight;
}

// Returns the percentile of the given value in a sorted numeric array.
function percentRank(arr, v) {
    if (typeof v !== 'number') throw new TypeError('v must be a number');
    for (var i = 0, l = arr.length; i < l; i++) {
        if (v <= arr[i]) {
            while (i < l && v === arr[i]) i++;
            if (i === 0) return 0;
            if (v !== arr[i-1]) {
                i += (v - arr[i-1]) / (arr[i] - arr[i-1]);
            }
            return i / l;
        }
    }
    return 1;
}
