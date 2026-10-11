export const CPP_KEYWORDS =
  "alignas alignof auto bool break case catch char class concept const consteval constexpr constinit const_cast continue co_await co_return co_yield decltype default delete do double dynamic_cast else enum explicit export extern false float for friend goto if inline int long mutable namespace new noexcept nullptr operator private protected public register reinterpret_cast requires return short signed sizeof static static_assert static_cast struct switch template this thread_local throw true try typedef typeid typename union unsigned using virtual void volatile while override final".split(
    " ",
  );

export const CPP_HEADERS =
  "algorithm array atomic bitset cassert cctype chrono cmath complex condition_variable cstdint cstdio cstdlib cstring ctime deque exception filesystem fstream functional future initializer_list iomanip ios iostream istream iterator limits list locale map memory mutex new numeric optional ostream queue random ranges regex set shared_mutex sstream stack stdexcept string string_view thread tuple type_traits typeinfo unordered_map unordered_set utility variant vector bit concepts format span numbers charconv version".split(
    " ",
  );

export const STD_NAMES =
  "vector string map unordered_map set unordered_set multiset multimap deque list array stack queue priority_queue pair tuple optional variant any bitset span string_view unique_ptr shared_ptr weak_ptr make_unique make_shared make_pair make_tuple move forward swap sort stable_sort partial_sort nth_element reverse unique find find_if find_if_not count count_if accumulate iota fill copy copy_if transform for_each min max minmax min_element max_element clamp lower_bound upper_bound binary_search next_permutation prev_permutation gcd lcm abs pow sqrt cin cout cerr clog endl flush getline stoi stol stoll stod stof to_string setw setprecision fixed left right hex dec boolalpha ifstream ofstream fstream stringstream istringstream ostringstream thread mutex lock_guard unique_lock condition_variable atomic async future promise chrono function bind ref cref invoke tie get size ssize begin end cbegin cend rbegin rend distance advance exception runtime_error invalid_argument out_of_range logic_error numeric_limits random_device mt19937 uniform_int_distribution uniform_real_distribution normal_distribution shuffle ranges views filesystem regex regex_match regex_search regex_replace format print println".split(
    " ",
  );

export const CPP_SNIPPETS: { label: string; insert: string; doc: string }[] = [
  { label: "main", insert: "int main() {\n\t${0}\n\treturn 0;\n}", doc: "main function" },
  { label: "for", insert: "for (int ${1:i} = 0; ${1:i} < ${2:n}; ++${1:i}) {\n\t${0}\n}", doc: "for loop" },
  { label: "forr", insert: "for (const auto& ${1:x} : ${2:container}) {\n\t${0}\n}", doc: "range-based for" },
  { label: "while", insert: "while (${1:cond}) {\n\t${0}\n}", doc: "while loop" },
  { label: "if", insert: "if (${1:cond}) {\n\t${0}\n}", doc: "if" },
  { label: "ifelse", insert: "if (${1:cond}) {\n\t${2}\n} else {\n\t${0}\n}", doc: "if / else" },
  { label: "class", insert: "class ${1:Name} {\npublic:\n\t${1:Name}() = default;\n\t${0}\n};", doc: "class" },
  { label: "struct", insert: "struct ${1:Name} {\n\t${0}\n};", doc: "struct" },
  { label: "template", insert: "template <typename ${1:T}>\n${0}", doc: "template" },
  { label: "lambda", insert: "[${1}](${2}) {\n\t${0}\n}", doc: "lambda" },
  { label: "cout", insert: 'std::cout << ${1:"text"} << std::endl;', doc: "print to stdout" },
  { label: "cin", insert: "std::cin >> ${1:x};", doc: "read from stdin" },
  { label: "fastio", insert: "std::ios::sync_with_stdio(false);\nstd::cin.tie(nullptr);", doc: "fast I/O" },
  { label: "include", insert: "#include <${1:iostream}>", doc: "include header" },
];
