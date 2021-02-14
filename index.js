const os = require("os");
const DNS = require("native-dns");
const Docker = require("dockerode");

const dnsServer = DNS.createServer();
const docker = new Docker({
  socketPath: "/var/run/docker.sock",
  version: "v1.41",
});

const parseSRVQuestions = (questions) => {
  const nameQuery = new Map();
  const labelQuery = new Map();
  for (const { name } of questions) {
    const parts = name.split(".");
    const service = parts.pop();
    if (service !== "docker") continue;

    const queryType = parts.pop();
    if (queryType === "name") {
      if (parts.length !== 1) {
        console.error("Question", name, "invalid, it must have 3 parts");
        continue;
      }
      nameQuery.set(parts[0], name);
    } else if (queryType === "label") {
      if (parts.length !== 2) {
        console.error("Question", name, "invalid, it must have 4 parts");
        continue;
      }
      const [labelValueDedotted, labelNameDedotted] = parts;
      labelQuery.set(labelNameDedotted.replace(/_/g, "."), {
        value: labelValueDedotted.replace(/_/g, "."),
        name,
      });
    } else {
      console.error("Unknown query", queryType, "in", name);
    }
  }
  return { nameQuery, labelQuery };
};

dnsServer.on("request", async function (request, response) {
  const containers = await docker.listContainers({
    filters: {
      health: ["healthy", "none"],
      status: ["running"],
    },
  });
  const { nameQuery, labelQuery } = parseSRVQuestions(request.question);

  console.log("Query", nameQuery, labelQuery);

  for (const container of containers) {
    let queryName = null;

    //console.log("Container", container);

    for (const name of container.Names) {
      const containerName = name.split("/").pop();
      if (nameQuery.has(containerName)) {
        queryName = nameQuery.get(containerName);
        break;
      }
    }

    for (const [labelName, { value, name }] of labelQuery) {
      if (
        labelName in container.Labels &&
        container.Labels[labelName] === value
      ) {
        queryName = name;
        break;
      }
    }

    if (queryName == null) continue;

    for (const port of container.Ports) {
      if (port.PublicPort == null) continue;

      response.answer.push(
        DNS.SRV({
          name: queryName,
          target: os.hostname(),
          port: port.PublicPort,
          ttl: 0,
          priority: 1,
          weight: 1,
        })
      );
    }
  }

  response.send();
});

dnsServer.on("error", function (err, buff, req, res) {
  console.log(err.stack);
});

dnsServer.serve(15353);
console.log("Docker Discovery DNS started on", 15353);
