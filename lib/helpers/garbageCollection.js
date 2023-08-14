/*
  This snippet can help your node automatically trigger garbage collection.
  You have to add V8 flag "--expose-gc" when you start your app.
  
  usage example: (triggerMemorySize - MB, triggerInterval - Seconds, startInvervalDelay - Seconds)
    require('/utils/garbageCollection.js');
    
 or require('/utils/garbageCollection.js')(triggerMemorySize, triggerInterval);
  such as : 
      require('/utils/garbageCollection.js')(150, 60);
 or require('/utils/garbageCollection.js')(triggerMemorySize, triggerInterval, startInvervalDelay);
  such as : 
      require('/utils/garbageCollection.js')(150, 60, 60);
*/

var garbageCollectionInterval = null;

var maximumMemory = 32; //Trigger garbage collection when memory usage over 150MB
var intervalTime = 60; //Check memory usage every 60 seconds

module.exports = (function (memorySize, interval, startInvervalDelay) {
    setTimeout(function () {
        if (global.gc) {
            maximumMemory = memorySize || maximumMemory;
            intervalTime = interval || intervalTime;

            if (!garbageCollectionInterval) {
                garbageCollectionInterval = setInterval(function () {
                    // var currentMemoryUsage = (process.memoryUsage().rss / 1048576).toFixed(2);
                    // if (currentMemoryUsage > maximumMemory) {
                        console.log('[Garbage Collection] > triggered garbage collection, current memory usage: %d MB');
                        global.gc();
                    // }
                }, intervalTime * 1000).unref();
                console.log('[Garbage Collection] > Automatic garbage collection started, will be triggered when memory bigger than %d MB for every %d seconds.', maximumMemory, intervalTime);
            }
        } else {
            console.error('[Garbage Collection] > Require node argument "--expose-gc", please start your app with this argument.');
        }
    }, startInvervalDelay * 1000);
})();
