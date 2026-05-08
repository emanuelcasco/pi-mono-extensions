export const WHOAMI = `query { viewer { id name email displayName } }`;

export const LIST_TEAMS = `query { teams { nodes { id name key description } } }`;

export const GET_TEAM = `query($id: String!) { team(id: $id) { id name key description organization { id name } } }`;

export const LIST_ISSUES = `query($filter: IssueFilter, $first: Int) {
  issues(filter: $filter, first: $first, orderBy: updatedAt) {
    nodes { id identifier title description priority url state { id name type } assignee { id name } team { id name key } labels { nodes { id name } } createdAt updatedAt }
    pageInfo { hasNextPage endCursor }
  }
}`;

export const GET_ISSUE = `query($id: String!) {
  issue(id: $id) {
    id identifier title description priority url
    state { id name type }
    assignee { id name email }
    team { id name key }
    project { id name }
    labels { nodes { id name } }
    parent { id identifier title }
    children { nodes { id identifier title } }
    comments { nodes { id body user { id name } createdAt } }
    createdAt updatedAt
  }
}`;

export const SEARCH_ISSUES = `query($term: String!, $first: Int) {
  searchIssues(term: $term, first: $first) {
    nodes { id identifier title description priority url state { id name type } assignee { id name } team { id name key } labels { nodes { id name } } createdAt }
    pageInfo { hasNextPage endCursor }
  }
}`;

export const LIST_MY_ISSUES = `query($first: Int) {
  viewer {
    id name
    assignedIssues(first: $first, orderBy: updatedAt, filter: { state: { type: { neq: "completed" } } }) {
      nodes { id identifier title priority url state { id name type } team { id name key } createdAt }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

export const CREATE_ISSUE = `mutation($input: IssueCreateInput!) {
  issueCreate(input: $input) { success issue { id identifier title url priority state { id name } } }
}`;

export const UPDATE_ISSUE = `mutation($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) { success issue { id identifier title priority state { id name } } }
}`;

export const LIST_PROJECTS = `query { projects { nodes { id name description state team { id name key } } } }`;
export const LIST_TEAM_PROJECTS = `query($id: String!) { team(id: $id) { id name projects { nodes { id name description state } } } }`;
export const GET_PROJECT = `query($id: String!) { project(id: $id) { id name description state url team { id name key } lead { id name } } }`;

export const LIST_STATUSES = `query { workflowStates { nodes { id name type color position team { id name key } } } }`;
export const LIST_TEAM_STATUSES = `query($id: String!) { team(id: $id) { id name states { nodes { id name type color position } } } }`;
export const GET_STATUS = `query($id: String!) { workflowState(id: $id) { id name type color position team { id name key } } }`;

export const LIST_LABELS = `query { issueLabels { nodes { id name color team { id name key } } } }`;
export const LIST_TEAM_LABELS = `query($id: String!) { team(id: $id) { id name labels { nodes { id name color } } } }`;

export const LIST_USERS = `query { users { nodes { id name email displayName } } }`;
export const GET_USER = `query($id: String!) { user(id: $id) { id name email displayName } }`;

export const LIST_COMMENTS = `query($id: String!) { issue(id: $id) { id identifier comments { nodes { id body user { id name } createdAt } } } }`;
export const CREATE_COMMENT = `mutation($input: CommentCreateInput!) {
  commentCreate(input: $input) { success comment { id body user { id name } createdAt } }
}`;

export const FILE_UPLOAD = `mutation($filename: String!, $contentType: String!, $size: Int!, $makePublic: Boolean, $metaData: JSON) {
  fileUpload(filename: $filename, contentType: $contentType, size: $size, makePublic: $makePublic, metaData: $metaData) {
    success
    uploadFile {
      filename
      contentType
      size
      uploadUrl
      assetUrl
      headers { key value }
      metaData
    }
  }
}`;

export const LIST_CYCLES = `query { cycles(first: 50, orderBy: createdAt) { nodes { id name number startDate endDate completedAt team { id name key } } } }`;
export const LIST_TEAM_CYCLES = `query($id: String!) { team(id: $id) { id name cycles { nodes { id name number startDate endDate completedAt } } } }`;

export const LIST_DOCUMENTS = `query { documents(first: 50, orderBy: updatedAt) { nodes { id title updatedAt project { id name } } } }`;
export const LIST_PROJECT_DOCUMENTS = `query($id: String!) { project(id: $id) { id name documents { nodes { id title updatedAt } } } }`;
export const GET_DOCUMENT = `query($id: String!) { document(id: $id) { id title content contentIcon project { id name } updatedAt } }`;

export const WORKSPACE_METADATA = `query {
  teams { nodes { id name key } }
  projects { nodes { id name description state team { id name } } }
  workflowStates { nodes { id name type color position team { id name key } } }
  issueLabels { nodes { id name color team { id name key } } }
  users { nodes { id name email displayName } }
}`;
