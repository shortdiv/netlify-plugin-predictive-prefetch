const fs = require('fs')
const path = require('path')
const {google} = require('googleapis')

const {
  SERVICE_ACCOUNT_EMAIL,
  GA_PRIVATE_KEY
} = process.env

const aggregateData = (rows) => {
  let data = {}
  for (let row of rows) {
    let [previousPagePath, pagePath] = row.dimensions
    let pageviews = +row.metrics[0].values[0]
    let exits = +row.metrics[0].values[1]

    if (/\?.*$/.test(pagePath) || /\?.*$/.test(previousPagePath)) {
      pagePath = pagePath.replace(/\?.*$/, '')
      previousPagePath = previousPagePath.replace(/\?.*$/, '')
    }

    // Ignore pageviews where the current and previous pages are the same.
    if (previousPagePath == pagePath) continue

    if (previousPagePath != '(entrance)') {
      data[previousPagePath] = data[previousPagePath] || {
        pagePath: previousPagePath,
        pageviews: 0,
        exits: 0,
        nextPageviews: 0,
        nextExits: 0,
        nextPages: {}
      }

      data[previousPagePath].nextPageviews += pageviews
      data[previousPagePath].nextExits += exits

      if (data[previousPagePath].nextPages[pagePath]) {
        data[previousPagePath].nextPages[pagePath] += pageviews
      } else {
        data[previousPagePath].nextPages[pagePath] = pageviews
      }
    }

    data[pagePath] = data[pagePath] || {
      pagePath: pagePath,
      pageviews: 0,
      exits: 0,
      nextPageviews: 0,
      nextExits: 0,
      nextPages: {}
    }

    data[pagePath].pageviews += pageviews
    data[pagePath].exits += exits
  }

  Object.keys(data).forEach((pagePath) => {
    const page = data[pagePath]
    page.nextPages = Object.keys(page.nextPages)
      .map((pagePath) => ({
        pagePath,
        pageviews: page.nextPages[pagePath]
      }))
      .sort((a, b) => {
        return b.pageviews - a.pageviews
      })
  })

  const pages = Object.keys(data)
    .filter((pagePath) => data[pagePath].nextPageviews > 0)
    .map((pagePath) => {
      const page = data[pagePath]
      const {exits, nextPageviews, nextPages} = page
      page.percentExits = exits / (exits + nextPageviews)
      page.topNextPageProbability =
        nextPages[0].pageviews / (exits + nextPageviews)
      return page
    })
    .sort((a, b) => {
      return b.pageviews - a.pageviews
    })

  return pages
}

const makePrediction = async (pages) => {
  const predictions = []
  for (let page of pages) {
    const prediction = {
      pagePath: page.pagePath,
      nextPagePath: page.nextPages[0] ? page.nextPages[0].pagePath : '',
      nextPageCertainty: page.nextPages[0] ? page.topNextPageProbability : ''
    }
    predictions.push(prediction)
  }
  return predictions
}

let predictions;

module.exports = {
  name: 'netlify-plugin-predictive-prefetch',
  onPostBuild:async ({ constants, inputs }) => {
    const startDate = inputs.startDate || "30daysAgo";
    const endDate = inputs.endDate || "yesterday";
    
    let buff = Buffer.from(GA_PRIVATE_KEY, 'base64');
    buff = buff.toString()
    

    const authClient = new google.auth.JWT({
      email: process.env.SERVICE_ACCOUNT_EMAIL,
      key: buff,
      scopes: ['https://www.googleapis.com/auth/analytics.readonly']
    })

    const queryParams = {
      resource: {
        reportRequests: [
          {
            viewId: process.env.VIEW_ID,
            dateRanges: [{startDate, endDate}],
            metrics: [
              {expression: 'ga:pageviews'},
              {expression: 'ga:exits'}
            ],
            dimensions: [
              {name: 'ga:previousPagePath'},
              {name: 'ga:pagePath'}
            ],
            orderBys: [
              {fieldName: 'ga:previousPagePath', sortOrder: 'ASCENDING'},
              {fieldName: 'ga:pageviews', sortOrder: 'DESCENDING'}
            ],
            pageSize: 10000
          }
        ]
      }
    }

    try {
      await authClient.authorize()
      const analytics = google.analyticsreporting({
        version: 'v4',
        auth: authClient
      })
      const response = await analytics.reports.batchGet(queryParams)
      let [report] = response.data.reports
      let {rows} = report.data
      
      const cleanedData = aggregateData(rows)
      predictions = await makePrediction(cleanedData)
      console.log(predictions)
    } catch (e) {
      console.log(e)
    }
  },
  onSuccess: async({constants}) => {
    for (let i=0; i<predictions.length; i++) {
      let route = predictions[i].pagePath
      const r = path.join(constants.BUILD_DIR, route)
      if (fs.existsSync(r)) {
        // console.log(`${r}index.html`)
        let htmlString = fs.readFileSync(`${r}index.html`, 'utf8')
        var head = htmlString.match(/<\/head>/gi);
        htmlString = htmlString.replace(head, `<link rel=\"prefetch\" href=\"${predictions[i].nextPagePath}\"></head>`)
        console.log(htmlString)
        fs.writeFileSync(`${r}index.html`, htmlString, err => {
          if (err) throw err
          console.log("file written")
        })
      }
    }
  }
}